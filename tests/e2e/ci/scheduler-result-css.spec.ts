import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * T312 — the Scheduler run-result block's LAYOUT, pinned in a real browser.
 * BUG-120 extends the same fixture with the takeover's OWN layout: its bottom
 * edge against the footer, and the single-header count. Same reason, same
 * blind spot — jsdom has no box model, so both defects were invisible to the
 * unit suite while shipping. One launched app, one seeded worker, reused.
 *
 * Why this file exists at all: the four rules in `SchedulerWorkerDetail.vue`'s
 * `<style scoped>` block are invisible to the unit suite. jsdom does not apply
 * scoped CSS, so deleting all 56 lines leaves the 14 scheduler spec files (338
 * tests) fully green — a refactor could drop the block, pass CI, and silently
 * reintroduce every defect T311 was written to fix. The unit tests are not
 * wrong (they check markup, the seam, and the `v-else` branch, all genuinely
 * CSS-independent); they simply cannot see layout. This spec adds the layer
 * that can.
 *
 * One rule → one assertion, so a deleted rule reddens a named test:
 *
 *   `.md-prose :deep(table) { min-width: max-content }` +
 *   `.md-prose :deep(.md-table-scroll) { overflow-x: auto }` (BUG-119, in the
 *   SHARED seam — `MarkdownRenderer.vue`; the local copies this block used to
 *   carry are deleted)
 *       → a wide markdown table keeps its columns instead of compressing to the
 *         panel and breaking header words mid-word, and scrolls inside its OWN
 *         wrapper rather than scrolling the whole result block with the prose
 *         in it.
 *   `.run-detail-body { width: 0; min-width: 100% }`
 *       → that scroll stays INSIDE the block: the runs table is not sized by
 *         the `colspan="5"` disclosure cell's max-content, so the runs column
 *         never overflows and the card's `overflow-hidden` never eats the
 *         Duration column.
 *   `.result-prose :deep(p) { white-space: pre-wrap }`
 *       → a stack trace keeps one rendered line per source line (markdown-it
 *         runs with `breaks: false`, so the newline survives into the HTML and
 *         HTML collapses it to a space without this).
 *   `.md-prose :deep(ul|ol) { list-style: disc|decimal }` (BUG-119 — also
 *   lifted into the shared seam; the local copy here is deleted)
 *       → markdown lists render markers (Tailwind preflight zeroes them).
 *   `.md-prose :deep(ul ul|ul ul ul|ol ol|ol ol ol)` (BUG-119 AC-2)
 *       → each nesting level renders a marker its parent does not, so a nested
 *         list does not read as one flat list.
 *   every OTHER `.md-prose` rule — `h1`/`h2`/`h3`, inline `code`, `pre`,
 *   `blockquote`, `a` (BUG-119 AC-7)
 *       → BUG-119 restored the list markers and moved the table's scroll
 *         WITHOUT changing anything else's appearance.
 *
 * The last two were added after a blind verification showed both ACs were
 * pinned only by a regex over `MarkdownRenderer.vue`'s `<style>` text. That
 * text match is defeasible in both directions and it was demonstrated, not
 * argued: collapsing all four nested markers to their parent's left this whole
 * file green, and wrecking `h3` + `code` + `pre` + `blockquote` left all 377
 * unit files (6722 tests) AND this file green. Anything asserted about how the
 * prose LOOKS belongs here, in Chromium, not in a stylesheet grep.
 *
 * Subscription-free, like `app-boot-mcp.spec.ts`: the worker is seeded on disk
 * DISARMED (`enabled: false`, `runOnBoot: false`), so the scheduler shell never
 * spawns `claude` — the run history is pre-written into the isolated userData
 * and only ever read back.
 *
 * Requires `npm run build` first (needs `out/main/index.js` + `out/renderer`).
 *
 * Known limit, stated rather than papered over: this pins the rules against
 * DELETION, not against WEAKENING. Swapping `min-width: max-content` for a
 * `min-width: 900px` that happens to exceed the seeded table would keep every
 * assertion green while the rule no longer expresses the intent. Catching that
 * would need a screenshot baseline, which is a different tool and a different
 * card; deletion is the failure mode that actually happened here.
 */

/** The worker's id — also the name of its runs file. */
const WORKER_ID = 't312-css-guard'

/** First line of the multi-line paragraph, used to find it in the DOM. */
const TRACE_FIRST_LINE = 'Error: boom in the scheduler tick'

/**
 * The seeded run result. Deliberately carries all four shapes at once so a
 * single expanded disclosure exercises every rule:
 *
 *  - a 3-source-line paragraph, each line short enough that WITHOUT `pre-wrap`
 *    the three collapse onto ONE rendered line — that is what makes the
 *    line-count assertion a real guard rather than a tautology;
 *  - a 7-column table whose cells are ordinary breakable words, so without
 *    `min-width: max-content` the inherited `word-break: break-word` really
 *    does compress it into the panel (again: the red must be reachable);
 *  - a flat `ul` and `ol`, AND a three-level nested one of each. The nested
 *    lists close AC-2 (BUG-119): with only the flat pair here, collapsing
 *    `ul ul`/`ul ul ul`/`ol ol`/`ol ol ol` to their parent's marker left this
 *    whole spec green, so the per-level rules were pinned by nothing that
 *    renders. Three levels because that is how many the seam declares;
 *  - one of every OTHER prose element the seam styles — `h1`/`h2`/`h3`, inline
 *    `code`, a fenced block (`pre`), a `blockquote` and an `a`. These exist
 *    solely so AC-7 ("no other prose element changed") has something to be
 *    false about: before them, wrecking four of those elements at once left
 *    all 6722 unit tests and all 7 specs here green.
 */
const RESULT = [
  TRACE_FIRST_LINE,
  'at tick (scheduler-shell.ts:359)',
  'at run (scheduler-core.ts:77)',
  '',
  '| Owner | Component | Severity | First seen | Last seen | Occurrences | Remediation owner | Tracking branch | Status |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  '| platform reliability | scheduler runner shell | critical | 2026-09-01T12:00 | 2026-09-08T18:30 | 1284 | reliability guild | card/T311-run-result | investigating |',
  '| session fleet | terminal ledger shell | major | 2026-09-03T09:15 | 2026-09-08T17:45 | 217 | fleet operators | card/T306-run-row | mitigated |',
  '',
  '- first bullet',
  '- second bullet',
  '',
  '1. first numbered',
  '2. second numbered',
  '',
  // Three ul levels and three ol levels (AC-2). Indentation is the parent's
  // CONTENT column — 2 spaces under `- `, 3 under `1. ` — which is what
  // CommonMark needs to nest rather than start a sibling list.
  '- unordered level one',
  '  - unordered level two',
  '    - unordered level three',
  '',
  '1. ordered level one',
  '   1. ordered level two',
  '      1. ordered level three',
  '',
  // Everything AC-7 claims BUG-119 did not touch.
  '# Heading one',
  '',
  '## Heading two',
  '',
  '### Heading three',
  '',
  'A paragraph with `inline code` and a [link](https://example.invalid/bug119).',
  '',
  '> a quoted line',
  '',
  '```ts',
  'const pinned = true',
  '```',
  ''
].join('\n')

function seedUserData(): string {
  const userData = mkdtempSync(join(tmpdir(), 'harnu-t312-'))

  // `schedulers.json` — the shape `parseWorkers` (scheduler-store.ts) reads.
  // DISARMED: `enabled: false` means neither the boot pass nor the 30s ticker
  // will ever spawn a run, so this spec needs no Claude and no subscription.
  writeFileSync(
    join(userData, 'schedulers.json'),
    JSON.stringify(
      {
        version: 1,
        workers: [
          {
            id: WORKER_ID,
            name: 'T312 CSS guard',
            enabled: false,
            prompt: 'never runs',
            folder: userData,
            everyMinutes: 30,
            runOnBoot: false,
            model: 'haiku',
            effort: 'low',
            mode: 'observe',
            timeoutSeconds: 300,
            carryLastResult: false,
            notifyOn: 'silent',
            failureStreak: 0
          }
        ]
      },
      null,
      2
    )
  )

  // `scheduler-runs/<workerId>.jsonl` — one Run per line (`parseRuns`).
  const startedAt = Date.UTC(2026, 8, 8, 12, 0, 0)
  mkdirSync(join(userData, 'scheduler-runs'), { recursive: true })
  writeFileSync(
    join(userData, 'scheduler-runs', `${WORKER_ID}.jsonl`),
    JSON.stringify({
      workerId: WORKER_ID,
      startedAt,
      endedAt: startedAt + 42_000,
      durationMs: 42_000,
      status: 'ok',
      result: RESULT,
      terminalReason: '',
      numTurns: 3,
      costUsd: 0.0123,
      tokens: { in: 100, out: 200, cacheRead: 0, cacheWrite: 0 },
      denials: []
    }) + '\n'
  )

  return userData
}

let app: ElectronApplication
let page: Page

/**
 * The three tests share one launched app and one expanded disclosure — nothing
 * here mutates state, so re-launching Electron per assertion would triple the
 * runtime for no isolation benefit.
 *
 * Deliberately NOT `describe.serial`: each test guards a different CSS rule, so
 * they must fail independently. Under `.serial` a red first test would skip the
 * other two, and "delete the whole style block, see how many assertions break"
 * — the check that proves this file is a guard and not decoration — would only
 * ever be able to report one.
 */
test.describe('scheduler run-result block — layout guards (T312)', () => {
  test.beforeAll(async () => {
    const userData = seedUserData()
    app = await electron.launch({
      args: ['out/main/index.js', `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, HOME: userData }
    })
    page = await app.firstWindow()
    await expect(page.locator('body')).toBeVisible()

    // Pin the window size: every measurement below is a comparison between two
    // elements in the SAME layout, but a deterministic viewport keeps the
    // seeded table reliably wider than the pane it has to overflow.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900)
    })

    // Open the Scheduler takeover the way a user does — the footer pill. It is
    // rendered unconditionally (`<StatusFooter />` in App.vue), and the
    // takeover is not onboarding-gated, so an empty fleet is fine.
    await page.locator('[data-dsqa="scheduler-footer-pill"]').click()
    await expect(page.locator('[data-dsqa="scheduler-takeover"]')).toBeVisible()

    // The seeded worker auto-selects (SchedulerView selects `workers[0]`), so
    // the Runs tab is already showing its one run.
    const row = page.locator('[data-dsqa="run-row"]').first()
    await expect(row).toBeVisible()

    // Expand the disclosure — the run detail is where `.run-detail-body` and
    // the nested-table interaction actually live.
    await row.click()
    await expect(page.locator('[data-dsqa="run-detail"]')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
  })

  /**
   * AC-1 + AC-2, asserted as one pair on purpose: each half is meaningless
   * alone. "The table scrolls somewhere" without "the column does not" is
   * satisfied by a layout that scrolls BOTH — which is the broken state. The
   * pair is what pins the `min-width: max-content` / `width: 0` interaction.
   *
   * **AC-1 changed shape in BUG-119, and the property it proves got stronger,
   * not weaker.** It used to read `block.scrollWidth > block.clientWidth` — the
   * whole result block scrolls. That was the only place the overflow could go
   * when the block was the nearest scroll container, and it is exactly the
   * defect BUG-119 fixed: scrolling right to read column seven dragged the
   * paragraphs above and below the table out of the viewport with it. The seam
   * now wraps every `<table>` in its own `overflow-x: auto` container, so the
   * block CANNOT still overflow — a wrapper that owns the scroll and a block
   * that still scrolls are mutually exclusive. The assertion is re-expressed
   * against the wrapper rather than deleted, and it now pins three things where
   * it pinned one:
   *
   *   1. the table still overflows something — it did not compress into the
   *      panel (this is what `min-width: max-content` buys, and the ONLY thing
   *      the old assertion actually proved);
   *   2. that something is the WRAPPER, not the block (the new half — the
   *      block must NOT scroll);
   *   3. and scrolling the wrapper really moves the table while leaving the
   *      prose above it where it was, which is the user-visible claim both of
   *      the above exist to serve.
   *
   * Each half reddens on its own, verified by deleting one seam rule at a time
   * rather than assumed: without `min-width: max-content` the table compresses
   * and (1) fails; without the wrapper's `overflow-x` the overflow propagates to
   * the block, which is a scroll container, and (2) fails.
   *
   * Consequence of sharing one test: `expect` stops at the first failure, so
   * deleting BOTH rules at once surfaces only the first failure and masks the
   * rest. Each still reddens on its own when only its own rule is deleted, which
   * is what makes each a guard; the masking only affects how many messages a
   * whole-block deletion prints, not whether it fails.
   */
  test('a wide table scrolls inside its own wrapper, never the block or the runs column', async () => {
    const prose = page.locator('[data-dsqa="run-detail"] [data-dsqa="run-result-prose"]')
    await expect(prose).toBeVisible()
    await expect(prose.locator('table')).toBeVisible()

    // AC-1 — the seam's `:deep(table) { min-width: max-content }` +
    // `:deep(.md-table-scroll) { overflow-x: auto }`, measured geometrically.
    const wrap = await prose.evaluate((el) => {
      const wrapper = el.querySelector('.md-table-scroll') as HTMLElement | null
      const table = wrapper?.querySelector('table') as HTMLElement | null
      const above = [...el.querySelectorAll('p')].at(0) as HTMLElement | undefined
      if (!wrapper || !table || !above) return null
      return {
        wrapperScrollWidth: wrapper.scrollWidth,
        wrapperClientWidth: wrapper.clientWidth,
        blockScrollWidth: el.scrollWidth,
        blockClientWidth: el.clientWidth,
        tableLeft: table.getBoundingClientRect().left,
        aboveLeft: above.getBoundingClientRect().left
      }
    })
    expect(wrap, 'the table must be wrapped by the seam in a .md-table-scroll').not.toBeNull()

    // (1) The table did not compress into the panel — it overflows its wrapper.
    expect(
      wrap!.wrapperScrollWidth,
      `the table must overflow its own wrapper: scrollWidth ${wrap!.wrapperScrollWidth} vs clientWidth ${wrap!.wrapperClientWidth}`
    ).toBeGreaterThan(wrap!.wrapperClientWidth)

    // (2) ...and the block does NOT scroll: the overflow stayed in the wrapper
    // instead of propagating to the nearest scroll container, which is the
    // block itself.
    expect(
      wrap!.blockScrollWidth,
      `the result block must NOT scroll horizontally: scrollWidth ${wrap!.blockScrollWidth} vs clientWidth ${wrap!.blockClientWidth}`
    ).toBe(wrap!.blockClientWidth)

    // (3) The user-visible claim: scroll the wrapper and the table moves while
    // the paragraph above it does not. Measured, not inferred from `overflow-x`
    // — a computed-style read would still pass on a layout that somehow moved
    // the prose anyway. Restored afterwards so the width measurements below are
    // taken from the same state the test started in.
    const moved = await prose.evaluate((el) => {
      const wrapper = el.querySelector('.md-table-scroll') as HTMLElement
      const table = wrapper.querySelector('table') as HTMLElement
      const above = [...el.querySelectorAll('p')].at(0) as HTMLElement
      wrapper.scrollLeft = wrapper.scrollWidth
      const out = {
        scrolled: wrapper.scrollLeft,
        tableLeft: table.getBoundingClientRect().left,
        aboveLeft: above.getBoundingClientRect().left
      }
      wrapper.scrollLeft = 0
      return out
    })
    expect(moved.scrolled, 'the wrapper must actually be scrollable').toBeGreaterThan(0)
    expect(
      moved.tableLeft,
      `the table must move when its wrapper scrolls: ${wrap!.tableLeft} → ${moved.tableLeft}`
    ).toBeLessThan(wrap!.tableLeft)
    expect(
      moved.aboveLeft,
      `the paragraph above the table must NOT move: ${wrap!.aboveLeft} → ${moved.aboveLeft}`
    ).toBe(wrap!.aboveLeft)

    // AC-2 — `.run-detail-body { width: 0; min-width: 100% }`. Measured in the
    // same layout, at the same moment, with the same table on screen.
    const column = page.locator('[data-dsqa="worker-detail-runs"]')
    const col = await column.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth
    }))
    expect(
      col.scrollWidth,
      `runs column must NOT scroll horizontally: scrollWidth ${col.scrollWidth} vs clientWidth ${col.clientWidth}`
    ).toBe(col.clientWidth)

    // The runs column alone under-reports the damage: the runs card between it
    // and the table is `overflow-hidden`, so an over-wide table is CLIPPED
    // there rather than propagated up as column overflow — which is exactly why
    // the original defect was only ever caught by diffing screenshots. (Proven,
    // not assumed: with `.run-detail-body` deleted, the column assertion above
    // PASSES and only the card assertion below goes red.) Measure the clip box
    // itself. It carries no `data-dsqa` of its own (this spec may not edit the
    // component), so it is reached structurally: the runs table's parent is the
    // bordered card.
    const clip = await page.evaluate(() => {
      const card = document.querySelector('[data-dsqa="run-row"]')?.closest('table')
        ?.parentElement as HTMLElement | undefined
      // Duration is the LAST column — select it as such. An index (`td[4]`)
      // would keep measuring cell five after a column is added or reordered,
      // and would keep passing while checking the wrong thing.
      const cell = document.querySelector(
        '[data-dsqa="run-row"] td:last-child'
      ) as HTMLElement | null
      if (!card || !cell) return null
      const cardRect = card.getBoundingClientRect()
      const cellRect = cell.getBoundingClientRect()
      return {
        cardOverflowX: getComputedStyle(card).overflowX,
        cardScrollWidth: card.scrollWidth,
        cardClientWidth: card.clientWidth,
        durationText: (cell.textContent ?? '').trim(),
        durationWidth: cellRect.width,
        durationRight: cellRect.right,
        cardContentRight: cardRect.left + card.clientWidth
      }
    })
    expect(clip, 'the runs card and its Duration cell must exist').not.toBeNull()

    // Self-validate the structural reach BEFORE trusting it. `scrollWidth ===
    // clientWidth` is trivially true of any element that shrink-wraps its
    // content, so if a wrapper is ever inserted between the table and the card
    // — or the card stops clipping — this assertion would quietly become
    // vacuous and go on passing. That is the exact failure mode this whole file
    // exists to prevent, so the guard has to be able to detect it in itself.
    expect(
      clip!.cardOverflowX,
      'the element reached as the runs card must actually be the clip box — if this is no longer `hidden`, the scrollWidth assertion below is measuring nothing'
    ).toBe('hidden')

    expect(
      clip!.cardScrollWidth,
      `the runs card is overflow-hidden, so content wider than it is silently clipped: scrollWidth ${clip!.cardScrollWidth} vs clientWidth ${clip!.cardClientWidth}`
    ).toBe(clip!.cardClientWidth)

    // ...and the column that actually gets eaten when that happens: Duration is
    // the last one, so assert its cell has a real box and that the box ends
    // inside the card's content edge.
    expect(clip!.durationText, 'the Duration cell must show a value').not.toBe('')
    expect(clip!.durationWidth).toBeGreaterThan(0)
    expect(
      clip!.durationRight,
      `Duration cell right edge ${clip!.durationRight} must sit inside the runs card content edge ${clip!.cardContentRight}`
    ).toBeLessThanOrEqual(clip!.cardContentRight + 1)
  })

  /**
   * AC-3 — `.result-prose :deep(p) { white-space: pre-wrap }`.
   *
   * Counted geometrically, not by reading `white-space` back off the computed
   * style: the claim being pinned is "three source lines render as three
   * lines", and a computed-style check would still pass on a layout that
   * somehow collapsed them anyway. A Range over the paragraph's contents yields
   * one client rect per line box; distinct `top` values are the rendered lines.
   */
  test('a multi-line result renders one rendered line per source line', async () => {
    const prose = page.locator('[data-dsqa="run-detail"] [data-dsqa="run-result-prose"]')
    const lines = await prose.evaluate((el, firstLine) => {
      const p = Array.from(el.querySelectorAll('p')).find((node) =>
        (node.textContent ?? '').startsWith(firstLine)
      )
      if (!p) return null
      const range = document.createRange()
      range.selectNodeContents(p)
      const tops = new Set(
        Array.from(range.getClientRects())
          .filter((r) => r.height > 0)
          .map((r) => Math.round(r.top))
      )
      return { renderedLines: tops.size, text: (p.textContent ?? '').trim() }
    }, TRACE_FIRST_LINE)

    expect(lines, 'the multi-line paragraph must be in the DOM').not.toBeNull()
    // The source really does carry three lines — otherwise the count below
    // would be trivially satisfied.
    expect(lines!.text.split('\n')).toHaveLength(3)
    expect(
      lines!.renderedLines,
      `three source lines must render as three lines, got ${lines!.renderedLines}`
    ).toBe(3)
  })

  /**
   * BUG-120 AC-6 — the takeover's bottom edge sits ABOVE the footer.
   *
   * `SchedulerView`'s root carried `h-full` while sitting BELOW
   * `TakeoverShell`'s 40px header — a declaration that is wrong about its own
   * box. It did NOT overflow, and the "it must spill over the footer" reading
   * of that is disproven below rather than repeated here: this view is the
   * shell's only flex child, so `flex-shrink` absorbs the surplus exactly.
   *
   * The assertion is still worth its keep, for the reason the whole file
   * exists: nothing in the chain clips (the takeover host is a plain
   * `absolute inset-0`), so an overflow HERE would be painted over the footer
   * rather than hidden, and jsdom — no box model, no flexbox — cannot see the
   * difference between `flex-1` and `h-full` at all. One sibling at that level
   * or a `flex-none` is all it takes, which is exactly the break the probe at
   * the end of this test injects.
   *
   * Measured as three independent claims, so a regression says WHICH one broke:
   * the view does not exceed its own shell, the takeover ends above the footer,
   * and the footer is still the element under its own pill (i.e. clickable, not
   * merely painted over by a transparent overflow).
   */
  test('the takeover ends above the footer, which stays visible and clickable', async () => {
    const box = await page.evaluate(() => {
      const view = document.querySelector('[data-dsqa="scheduler-takeover"]') as HTMLElement | null
      // The shell root is the view's parent — `TakeoverShell.vue` owns it and
      // carries no `data-dsqa` of its own (this spec may not edit it).
      const shell = view?.parentElement as HTMLElement | undefined
      const pill = document.querySelector(
        '[data-dsqa="scheduler-footer-pill"]'
      ) as HTMLElement | null
      const footer = pill?.closest('footer') as HTMLElement | undefined
      if (!view || !shell || !pill || !footer) return null

      const v = view.getBoundingClientRect()
      const s = shell.getBoundingClientRect()
      const f = footer.getBoundingClientRect()
      const p = pill.getBoundingClientRect()
      // What the user's click actually lands on at the pill's centre.
      const hit = document.elementFromPoint(p.left + p.width / 2, p.top + p.height / 2)

      return {
        viewBottom: v.bottom,
        viewHeight: v.height,
        shellBottom: s.bottom,
        shellHeight: s.height,
        footerTop: f.top,
        footerHeight: f.height,
        hitInsideFooter: hit ? footer.contains(hit) : false,
        hitTag: hit
          ? `${hit.tagName.toLowerCase()}${hit.className ? '.' + String(hit.className).split(' ')[0] : ''}`
          : 'none'
      }
    })

    expect(box, 'the takeover, its shell and the footer must all be on screen').not.toBeNull()

    // The footer has a real box — otherwise every comparison below is vacuous.
    expect(box!.footerHeight, 'the footer must have a height to sit below').toBeGreaterThan(0)

    // 1. The view never outgrows the shell that contains it. This is the
    //    `h-full` defect stated directly: the surplus is exactly the shell's
    //    40px header.
    expect(
      box!.viewBottom,
      `the Scheduler view overflows its TakeoverShell by ${Math.round(box!.viewBottom - box!.shellBottom)}px — its bottom edge is ${box!.viewBottom} vs the shell's ${box!.shellBottom} (view ${box!.viewHeight}px inside a ${box!.shellHeight}px shell)`
    ).toBeLessThanOrEqual(box!.shellBottom + 1)

    // 2. ...and therefore ends above the footer's top edge.
    expect(
      box!.viewBottom,
      `the Scheduler takeover overlaps the footer by ${Math.round(box!.viewBottom - box!.footerTop)}px — takeover bottom ${box!.viewBottom} vs footer top ${box!.footerTop}`
    ).toBeLessThanOrEqual(box!.footerTop + 1)

    // 3. Clickable, not just visible: the element under the footer pill's own
    //    centre is inside the footer, not something painted over it.
    expect(
      box!.hitInsideFooter,
      `the footer pill is covered — the element at its centre is <${box!.hitTag}>, outside the footer`
    ).toBe(true)

    // ── The guard proves itself ──────────────────────────────────────────────
    //
    // Everything above is a comparison between two boxes in a HEALTHY layout,
    // and such a comparison passes just as happily when it has stopped
    // measuring anything real (a renamed `data-dsqa`, a wrapper inserted
    // between the view and its shell, a footer that no longer has a box). The
    // T312 clip-box assertion in this same file self-validates for exactly
    // that reason; this one has a sharper motive still.
    //
    // The mechanism BUG-120 was filed against — a `h-full` root sitting below
    // the shell's 40px header, so the view measures `40px + 100%` — does NOT
    // on its own overflow anything, and that was verified rather than assumed:
    // rebuilding with `h-full` restored, and again with the entire pre-fix
    // component from `HEAD`, leaves all three assertions above green. The view
    // is the shell's only flex child, so `flex-shrink: 1` absorbs the 40px
    // surplus and hands back exactly the height the shell had left. Removing
    // `h-full` is still correct (it removes a latent trap and matches every
    // other takeover), but a proof built on "restore `h-full`, watch it go
    // red" would be reporting a red that cannot happen.
    //
    // So the overflow is injected directly, at the one place flexbox stops
    // rescuing it: `height: 100%` with flexing switched off (`flex: none`),
    // which is `h-full` with neither the `flex-1` basis nor the shrink that
    // currently absorb it. That is the real failure mode this assertion is
    // here for — a view that takes the whole shell's height while starting
    // below its 40px header — and it must be detected.
    // Reverted in the same call so the shared app is untouched for the tests
    // that follow.
    const probe = await page.evaluate(() => {
      const view = document.querySelector('[data-dsqa="scheduler-takeover"]') as HTMLElement | null
      const pill = document.querySelector(
        '[data-dsqa="scheduler-footer-pill"]'
      ) as HTMLElement | null
      const footer = pill?.closest('footer') as HTMLElement | undefined
      if (!view || !pill || !footer) return null

      const measure = (): { bottom: number; footerTop: number; hitInsideFooter: boolean } => {
        const p = pill.getBoundingClientRect()
        const hit = document.elementFromPoint(p.left + p.width / 2, p.top + p.height / 2)
        return {
          bottom: view.getBoundingClientRect().bottom,
          footerTop: footer.getBoundingClientRect().top,
          hitInsideFooter: hit ? footer.contains(hit) : false
        }
      }

      // `flex: none` + `height: 100%` — a root that takes the SHELL's full
      // height as its own while starting below the shell's header, with the
      // shrink that currently rescues `h-full` switched off.
      view.style.flex = 'none'
      view.style.height = '100%'
      view.getBoundingClientRect() // force layout
      const broken = measure()

      view.style.flex = ''
      view.style.height = ''
      view.getBoundingClientRect()
      const restored = measure()

      return { broken, restored }
    })

    expect(probe, 'the probe needs the takeover and the footer').not.toBeNull()
    expect(
      probe!.broken.bottom,
      'a full-height, non-shrinkable root below the 40px header MUST be caught as overflow — if this passes, the assertions above are not measuring the takeover any more'
    ).toBeGreaterThan(probe!.broken.footerTop)
    expect(
      probe!.broken.hitInsideFooter,
      'an overflowing takeover MUST cover the footer pill — if this stays true, the hit test above proves nothing'
    ).toBe(false)

    // ...and the app is handed back to the following tests exactly as found.
    expect(probe!.restored.bottom).toBeLessThanOrEqual(probe!.restored.footerTop + 1)
    expect(probe!.restored.hitInsideFooter).toBe(true)
  })

  /**
   * BUG-120 (delta) — the takeover must not end in a second status bar.
   *
   * This is the symptom the operator actually reported. The Scheduler's
   * `footerNote` strip carried the app status footer's own treatment — same
   * `bg-surface` background, same `border-t border-border`, same 11px type —
   * and sat flush on it, so 30px + 24px read as one doubled bar with a
   * hairline through the middle: the mirror at the bottom of the doubled
   * header at the top. Removing the second header did nothing about it.
   *
   * The predicate is the rule `design.md` states, not the CSS that happened to
   * be there: **the window has exactly one bar at its bottom, and it belongs to
   * the status footer** — so nothing that ends where the footer begins carries
   * a top border, whatever its background. An earlier version of this test
   * required the background to MATCH the footer's too, which left the obvious
   * hole open: `border-t` + `bg-surface-2` still reads as a second bar to the
   * eye and would have passed.
   *
   * Two limits, stated rather than papered over:
   *   - The scan is the SHELL's subtree, not just the view's, so a bar
   *     contributed by `TakeoverShell` itself is covered too. Anything outside
   *     the shell is not.
   *   - An element is "at the edge" within 2px. A strip pushed off the footer
   *     by a margin would read as a second bar to the eye and escape this. The
   *     margin case has never occurred here; the flush case is the one that
   *     shipped.
   */
  test('the takeover does not end in a second bar above the status footer', async () => {
    const read = await page.evaluate(() => {
      const view = document.querySelector('[data-dsqa="scheduler-takeover"]') as HTMLElement | null
      const pill = document.querySelector(
        '[data-dsqa="scheduler-footer-pill"]'
      ) as HTMLElement | null
      const footer = pill?.closest('footer') as HTMLElement | undefined
      if (!view || !footer) return null

      // Scan from the shell (the view's parent) so chrome the shell itself
      // might add at that edge is covered, not only the view's own.
      const shell = (view.parentElement ?? view) as HTMLElement
      const footerStyle = getComputedStyle(footer)
      const footerTop = footer.getBoundingClientRect().top

      /**
       * Everything the user sees immediately above the footer. The view root
       * and the shell root are included on purpose: they end there too, and it
       * would be just as wrong for either of them to draw the bar.
       */
      const atTheEdge = (): Array<{
        tag: string
        cls: string
        bg: string
        borderTopWidth: number
        drawsABar: boolean
      }> =>
        Array.from(shell.querySelectorAll<HTMLElement>('*'))
          .concat(shell)
          .filter((el) => Math.abs(el.getBoundingClientRect().bottom - footerTop) <= 2)
          .map((el) => {
            const st = getComputedStyle(el)
            const borderTopWidth = parseFloat(st.borderTopWidth) || 0
            return {
              tag: el.tagName.toLowerCase(),
              cls: String(el.className).slice(0, 70),
              bg: st.backgroundColor,
              borderTopWidth,
              drawsABar: borderTopWidth > 0
            }
          })

      const clean = atTheEdge()

      /**
       * Self-validation, deliberately using the RESTYLE the old predicate would
       * have missed: a top border over `--surface-2`, not over the footer's own
       * background. If this does not fire, the assertion below is decoration.
       * Reverted in the same call.
       */
      const strip = view.lastElementChild as HTMLElement | null
      let injected: ReturnType<typeof atTheEdge> = []
      if (strip) {
        const prevBg = strip.style.backgroundColor
        const prevBorder = strip.style.borderTop
        strip.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue(
          '--color-surface-2'
        )
        strip.style.borderTop = `1px solid ${footerStyle.borderTopColor}`
        strip.getBoundingClientRect()
        injected = atTheEdge()
        strip.style.backgroundColor = prevBg
        strip.style.borderTop = prevBorder
        strip.getBoundingClientRect()
      }

      return {
        footerHasOwnBar:
          (parseFloat(footerStyle.borderTopWidth) || 0) > 0 &&
          footerStyle.backgroundColor !== 'rgba(0, 0, 0, 0)',
        clean,
        injected,
        restored: atTheEdge()
      }
    })

    expect(read, 'the takeover and the footer must be on screen').not.toBeNull()

    // The footer really does draw the one bar down there — otherwise "the
    // takeover must not draw a second one" is a claim about nothing.
    expect(
      read!.footerHasOwnBar,
      'the status footer must have its own border + background for this to mean anything'
    ).toBe(true)

    // Something is actually being measured at that edge.
    expect(
      read!.clean.length,
      'no element ends at the footer edge — this assertion is measuring nothing'
    ).toBeGreaterThan(0)

    const bars = read!.clean.filter((el) => el.drawsABar)
    expect(
      bars,
      `the takeover ends in a bar of its own, stacked on the status footer's: ${bars
        .map((o) => `<${o.tag} class="${o.cls}"> bg=${o.bg} border-top=${o.borderTopWidth}px`)
        .join('; ')}`
    ).toHaveLength(0)

    // ...and the check is not vacuous: a restyled bar (top border over
    // `--surface-2`, NOT the footer's background) still fires it.
    expect(
      read!.injected.filter((el) => el.drawsABar).length,
      'a top border at the footer edge MUST be caught whatever the background — if it is not, this assertion is decoration'
    ).toBeGreaterThan(0)

    // ...and the app is handed back exactly as found.
    expect(read!.restored.filter((el) => el.drawsABar)).toHaveLength(0)
  })

  /**
   * BUG-120 AC-2 — exactly one header, one title, one close button.
   *
   * The view used to draw its own 40px header under `TakeoverShell`'s, so the
   * takeover rendered two titles and two close buttons stacked. Counted in the
   * browser next to AC-6 because both symptoms share the one cause, and a
   * count here also proves the teleported content did not land twice.
   */
  test('the takeover renders exactly one header, one title and one close button', async () => {
    const counts = await page.evaluate(() => {
      const view = document.querySelector('[data-dsqa="scheduler-takeover"]') as HTMLElement | null
      const shell = view?.parentElement as HTMLElement | undefined
      if (!view || !shell) return null
      const header = shell.querySelector('header') as HTMLElement | null
      return {
        headers: shell.querySelectorAll('header').length,
        headerHeight: header?.getBoundingClientRect().height ?? 0,
        // The close button is the one labelled with the view's `scheduler.close`
        // string — the shell derives that label from `scheduler.title`.
        closeButtons: shell.querySelectorAll('[aria-label="Close scheduler"]').length,
        titles: Array.from(shell.querySelectorAll('span')).filter(
          (el) => (el.textContent ?? '').trim() === 'Scheduler' && el.children.length === 0
        ).length,
        // The teleported header content must be present exactly once.
        icons: (shell.querySelector('#takeover-shell-icon')?.querySelectorAll('svg') ?? []).length,
        newWorkerButtons: Array.from(
          shell.querySelectorAll('#takeover-shell-actions button')
        ).filter((el) => (el.textContent ?? '').includes('New worker')).length
      }
    })

    expect(counts, 'the takeover and its shell must be on screen').not.toBeNull()
    expect(counts!.headers, 'two stacked headers is the second symptom of BUG-120').toBe(1)
    expect(counts!.headerHeight, 'the shared header is 40px (design.md §6)').toBe(40)
    expect(counts!.closeButtons, 'the view must not draw a close button of its own').toBe(1)
    expect(counts!.titles, 'the title must render once').toBe(1)
    expect(counts!.icons, 'the Clock icon must land in the shell header exactly once').toBe(1)
    expect(counts!.newWorkerButtons, 'New worker must render once, in the shell header').toBe(1)
  })

  /** AC-4 — `.result-prose :deep(ul|ol)`. Tailwind preflight sets `none`. */
  test('markdown lists render their list markers', async () => {
    const prose = page.locator('[data-dsqa="run-detail"] [data-dsqa="run-result-prose"]')
    const markers = await prose.evaluate((el) => {
      const ul = el.querySelector('ul')
      const ol = el.querySelector('ol')
      if (!ul || !ol) return null
      return {
        ul: getComputedStyle(ul).listStyleType,
        ol: getComputedStyle(ol).listStyleType
      }
    })

    expect(markers, 'the result must render both a ul and an ol').not.toBeNull()
    expect(markers!.ul, 'ul must not render marker-less').not.toBe('none')
    expect(markers!.ol, 'ol must not render marker-less').not.toBe('none')
    expect(markers!.ul).toBe('disc')
    expect(markers!.ol).toBe('decimal')
  })

  /**
   * BUG-119 AC-2 — each nesting level renders a DISTINGUISHABLE marker, read
   * back from Chromium rather than from the stylesheet text.
   *
   * This test exists because the AC was previously pinned only by a regex over
   * `MarkdownRenderer.vue`'s `<style>` string. Collapsing all four nested
   * declarations to their parent's marker (`ul ul`/`ul ul ul` → `disc`,
   * `ol ol`/`ol ol ol` → `decimal`) — a list that reads as one flat list, which
   * is exactly the defect AC-2 names — reddened that text match and left every
   * spec in this file green, because the fixture carried only flat lists.
   *
   * Depth is counted as SAME-TAG ancestors, because that is what the CSS says:
   * `ul ul` matches a `ul` with a `ul` ancestor at any distance, and the
   * intervening `li` is irrelevant to it. Counting any-tag ancestors would
   * describe a different rule than the one being pinned.
   *
   * Asserted over EVERY list at each depth, not the first one found: depth 0
   * contains both the flat lists and the roots of the nested ones, and "all of
   * them" is the actual claim (a rule that reached only the first would be a
   * regression the seam has no way to express).
   */
  test('each nested list level renders a distinguishable marker', async () => {
    const prose = page.locator('[data-dsqa="run-detail"] [data-dsqa="run-result-prose"]')
    const byDepth = await prose.evaluate((el) => {
      const collect = (tag: 'ul' | 'ol'): string[][] => {
        const levels: string[][] = []
        for (const list of Array.from(el.querySelectorAll(tag))) {
          let depth = 0
          for (let p = list.parentElement; p && p !== el; p = p.parentElement) {
            if (p.tagName.toLowerCase() === tag) depth++
          }
          ;(levels[depth] ??= []).push(getComputedStyle(list).listStyleType)
        }
        return levels
      }
      return { ul: collect('ul'), ol: collect('ol') }
    })

    // The fixture really does nest three deep — otherwise every assertion
    // below would be vacuously true of an empty array.
    expect(byDepth.ul, 'the fixture must render three ul levels').toHaveLength(3)
    expect(byDepth.ol, 'the fixture must render three ol levels').toHaveLength(3)

    const uniq = (values: string[]): string[] => [...new Set(values)]

    expect(uniq(byDepth.ul[0]), 'top-level ul').toEqual(['disc'])
    expect(uniq(byDepth.ul[1]), 'ul nested once').toEqual(['circle'])
    expect(uniq(byDepth.ul[2]), 'ul nested twice').toEqual(['square'])
    expect(uniq(byDepth.ol[0]), 'top-level ol').toEqual(['decimal'])
    expect(uniq(byDepth.ol[1]), 'ol nested once').toEqual(['lower-alpha'])
    expect(uniq(byDepth.ol[2]), 'ol nested twice').toEqual(['lower-roman'])

    // The point of the AC, stated as its own claim: whatever the markers are,
    // no level may repeat its parent's. This is what fails on a "restore the
    // markers with one `list-style: disc` for everything" regression, even if
    // someone later changes which named types the seam picks.
    expect(uniq(byDepth.ul.flatMap(uniq)), 'ul levels must all differ').toHaveLength(3)
    expect(uniq(byDepth.ol.flatMap(uniq)), 'ol levels must all differ').toHaveLength(3)
  })

  /**
   * BUG-119 AC-7 — "no other prose element changed appearance as a side
   * effect", made FALSIFIABLE.
   *
   * Until this test, AC-7 was backed by a regex over the stylesheet text
   * asserting seven literal declarations. Everything outside those seven was
   * unguarded, and that is not a theoretical gap: changing `h3` font-size
   * 13px→26px, inline `code` and `pre` background + padding, and `blockquote`
   * padding-left + colour — five declarations, four visibly wrecked elements —
   * left all 377 unit files (6722 tests) AND all 7 specs in this file green.
   *
   * Colours are compared against the RESOLVED design token rather than a
   * hard-coded `rgb(...)`, via a probe element in the same document. Two
   * reasons: the literal differs per theme, so a hard-coded triple would pin
   * the test to whichever theme the fixture happens to boot in; and the claim
   * is "still the same token", which is what actually reddens when someone
   * swaps `--color-surface-2` for another token that renders a similar grey.
   *
   * Reported as a LIST of drifted properties rather than one `expect` per
   * property, on purpose: `expect` stops at the first failure, and a broad
   * regression (a typography plugin, a reset) moves many of these at once. A
   * re-grader should see every property that moved in one run, not the first.
   */
  test('no other prose element changed appearance (AC-7)', async () => {
    const prose = page.locator('[data-dsqa="run-detail"] [data-dsqa="run-result-prose"]')
    const seen = await prose.evaluate((el) => {
      /** A CSS var as Chromium resolves it, normalised to the `rgb(...)` form
       *  `getComputedStyle` returns for a colour. */
      const token = (name: string): string => {
        const probe = document.createElement('span')
        probe.style.color = `var(${name})`
        el.appendChild(probe)
        const resolved = getComputedStyle(probe).color
        probe.remove()
        return resolved
      }

      const one = (selector: string): CSSStyleDeclaration | null => {
        const node = el.querySelector(selector)
        return node ? getComputedStyle(node) : null
      }

      const h1 = one('h1')
      const h2 = one('h2')
      const h3 = one('h3')
      // The inline `code` is the one that is NOT inside the fenced block.
      const codeNode = Array.from(el.querySelectorAll('code')).find((node) => !node.closest('pre'))
      const code = codeNode ? getComputedStyle(codeNode) : null
      const pre = one('pre')
      const quote = one('blockquote')
      const link = one('a')
      if (!h1 || !h2 || !h3 || !code || !pre || !quote || !link) return null

      return {
        tokens: {
          text: token('--color-text'),
          text3: token('--color-text-3'),
          surface2: token('--color-surface-2'),
          border: token('--color-border'),
          accent: token('--color-accent'),
          accentLine: token('--color-accent-line')
        },
        h1: {
          fontSize: h1.fontSize,
          fontWeight: h1.fontWeight,
          color: h1.color,
          borderBottomWidth: h1.borderBottomWidth,
          borderBottomColor: h1.borderBottomColor
        },
        h2: { fontSize: h2.fontSize, fontWeight: h2.fontWeight, color: h2.color },
        h3: { fontSize: h3.fontSize, fontWeight: h3.fontWeight, color: h3.color },
        code: {
          fontSize: code.fontSize,
          background: code.backgroundColor,
          padding: `${code.paddingTop} ${code.paddingRight} ${code.paddingBottom} ${code.paddingLeft}`
        },
        pre: {
          fontSize: pre.fontSize,
          background: pre.backgroundColor,
          padding: `${pre.paddingTop} ${pre.paddingRight} ${pre.paddingBottom} ${pre.paddingLeft}`,
          overflowX: pre.overflowX,
          borderTopWidth: pre.borderTopWidth
        },
        blockquote: {
          borderLeftWidth: quote.borderLeftWidth,
          borderLeftStyle: quote.borderLeftStyle,
          borderLeftColor: quote.borderLeftColor,
          paddingLeft: quote.paddingLeft,
          color: quote.color
        },
        a: { color: link.color, textDecorationLine: link.textDecorationLine }
      }
    })

    expect(seen, 'the fixture must render every prose element AC-7 covers').not.toBeNull()
    const { tokens } = seen!

    /** `[property, actual, expected]` — every value `MarkdownRenderer.vue`'s
     *  `<style scoped>` authors for an element BUG-119 must not have touched. */
    const checks: [string, string, string][] = [
      ['h1.font-size', seen!.h1.fontSize, '18px'],
      ['h1.font-weight', seen!.h1.fontWeight, '600'],
      ['h1.color', seen!.h1.color, tokens.text],
      ['h1.border-bottom-width', seen!.h1.borderBottomWidth, '1px'],
      ['h1.border-bottom-color', seen!.h1.borderBottomColor, tokens.border],
      ['h2.font-size', seen!.h2.fontSize, '15px'],
      ['h2.font-weight', seen!.h2.fontWeight, '600'],
      ['h2.color', seen!.h2.color, tokens.text],
      ['h3.font-size', seen!.h3.fontSize, '13px'],
      ['h3.font-weight', seen!.h3.fontWeight, '600'],
      ['h3.color', seen!.h3.color, tokens.text],
      ['code.font-size', seen!.code.fontSize, '11.5px'],
      ['code.background', seen!.code.background, tokens.surface2],
      ['code.padding', seen!.code.padding, '1px 4px 1px 4px'],
      ['pre.font-size', seen!.pre.fontSize, '11.5px'],
      ['pre.background', seen!.pre.background, tokens.surface2],
      ['pre.padding', seen!.pre.padding, '10px 12px 10px 12px'],
      ['pre.overflow-x', seen!.pre.overflowX, 'auto'],
      ['pre.border-width', seen!.pre.borderTopWidth, '1px'],
      ['blockquote.border-left-width', seen!.blockquote.borderLeftWidth, '2px'],
      ['blockquote.border-left-style', seen!.blockquote.borderLeftStyle, 'solid'],
      ['blockquote.border-left-color', seen!.blockquote.borderLeftColor, tokens.accentLine],
      ['blockquote.padding-left', seen!.blockquote.paddingLeft, '10px'],
      ['blockquote.color', seen!.blockquote.color, tokens.text3],
      ['a.color', seen!.a.color, tokens.accent],
      ['a.text-decoration', seen!.a.textDecorationLine, 'none']
    ]

    const drifted = checks
      .filter(([, actual, expected]) => actual !== expected)
      .map(([property, actual, expected]) => `${property}: got ${actual}, want ${expected}`)

    expect(drifted, 'these prose properties changed appearance').toEqual([])
  })
})
