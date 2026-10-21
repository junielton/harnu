import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './fixtures/launch-app'
import { collectAppDiagnostics, type AppDiagnostics } from './fixtures/app-diagnostics'
import { rmSync } from 'node:fs'
import { seedDialogWorld, seedLaunchEnv, type DialogSeed } from './fixtures/dialog-seed'
import { SEEDED_ROUTES, ROUTES, closeRoute } from '../../../scripts/dev/dialog-routes/index.mjs'
import { measureDialog, violations } from '../../../scripts/dev/dialog-routes/measure.mjs'

/**
 * T460 batch 0 — the dialog GEOMETRY invariants, pinned in real Chromium (spec §6.3 step 8).
 *
 * jsdom has no layout engine, so "the footer is on screen" is invisible to the unit suite: BUG-184
 * (the bulk-clean dialog's header and footer scrolled out of the viewport with 33+ rows) shipped
 * green. This spec launches the BUILT app from a seeded `userData` (the same on-disk world the
 * before/after baseline uses: `fixtures/dialog-seed.ts`), opens every dialog the seed can reach
 * through its UI route, and asserts, at window heights 900 and 560:
 *
 *   - the card never starts above the viewport and never ends below it,
 *   - header and footer (when the dialog has them) are on screen,
 *   - for routes seeded with long content, the BODY is what scrolls,
 *   - once the shared primitive exists (batch 1 declares `--z-dialog`), every card declares a
 *     `max-height` no taller than `--dialog-max-h`.
 *
 * KNOWN VIOLATORS are `test.fixme` with the reason and the card that owns the fix; each batch
 * flips its own fixmes in the SAME commit as the fix, mirroring `KNOWN_DEVIATIONS`
 * (tests/dialog-surfaces.characterization.test.ts). Run with `DIALOG_GEOMETRY_RUN_FIXME=1` to
 * execute them anyway — that is how this file shows each fixme is red for the stated reason and
 * not a silent skip.
 *
 * NOT reachable here, by design (spec §6.3 step 3): Containers remove (needs Docker), the
 * ReviewPane confirm (needs a PR), the MCP gate (needs an MCP caller) and the Image lightbox
 * (needs a pasted image). They stay on unit tests + the human pass.
 *
 * Requires `npm run build` first (needs `out/main/index.js` + `out/renderer`). NO
 * `--remote-debugging-port`: on a built app that would flip `is.dev` and send the renderer to the
 * dev URL (docs/dev/live-verify-second-instance.md).
 */

const HEIGHTS = [900, 560] as const
const WIDTH = 1280

/**
 * Dialogs whose geometry is broken TODAY, keyed `<route id>@<height>`. Every entry names its fix.
 * Add a row only for a violation the run actually produced; never to silence a new one.
 */
const KNOWN_VIOLATORS: Record<string, string> = {
  // KNOWN_VIOLATORS:BEGIN — one entry per line, sorted. The batch that fixes one deletes its line.
  // BUG-184: the bulk-clean card has no max-height. With a long list the FOOTER leaves the viewport
  // (ready @560: the card ends at 580 in a 560px window) or the HEADER does (review @900/@560: the
  // card is taller than the window and is centered, so its top is above the viewport and its footer
  // stays visible). BUG-184 owns the flip.
  'CleanupBulkConfirmDialog#ready@560':
    'BUG-184 — the card is 517px tall with no cap; its footer ends at 580px in a 560px window',
  'CleanupBulkConfirmDialog#review-few@560':
    'BUG-184 — 1 row + 16 refused make the card 1257px tall with no cap; its header is above the viewport',
  'CleanupBulkConfirmDialog#review-few@900':
    'BUG-184 — 1 row + 16 refused make the card 1257px tall with no cap; its header is above the viewport',
  'CleanupBulkConfirmDialog#review@560':
    'BUG-184 — 33 rows + 16 refused make the card 1423px tall with no cap; its header is above the viewport',
  'CleanupBulkConfirmDialog#review@900':
    'BUG-184 — 33 rows + 16 refused make the card 1423px tall with no cap; its header is above the viewport'
  // KNOWN_VIOLATORS:END
}

let seed: DialogSeed
let app: ElectronApplication
let page: Page
let diag: AppDiagnostics

test.describe('dialog geometry invariants (T460 batch 0)', () => {
  test.beforeAll(async () => {
    seed = seedDialogWorld()
    app = await launchApp({ userData: seed.userData, env: seedLaunchEnv(seed) })
    page = await app.firstWindow()
    diag = collectAppDiagnostics(app, page)
    await expect(page.locator('body')).toBeVisible()
    // The first-run "Harnu mod" toast covers the footer; it is not part of any dialog.
    await page.waitForTimeout(1500)
  })

  // BUG-205: a red run attaches what the app knew (navigations, crashes, the main process's exit
  // state and stderr), because Playwright reports every main-process evaluate failure as a
  // "navigation" and the CI artifact otherwise says nothing about the main process.
  test.afterEach(async () => {
    const testInfo = test.info()
    if (testInfo.status === testInfo.expectedStatus || !diag) return
    await testInfo.attach('app-diagnostics', {
      body: await diag.report(),
      contentType: 'text/plain'
    })
  })

  test.afterAll(async () => {
    await app?.close()
    if (seed) rmSync(seed.root, { recursive: true, force: true })
  })

  for (const route of SEEDED_ROUTES) {
    for (const height of HEIGHTS) {
      const key = `${route.id}@${height}`
      test(`${route.id} keeps its header and footer on screen at ${height}px`, async () => {
        const reason = KNOWN_VIOLATORS[key]
        if (reason && !process.env.DIALOG_GEOMETRY_RUN_FIXME) test.fixme(true, reason)

        await app.evaluate(
          ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]?.setContentSize(w, h),
          [WIDTH, height]
        )
        await page.waitForTimeout(200)

        const ctx = { page, app, seed }
        await route.open(ctx)
        try {
          const m = await measureDialog(page, { settleMs: 150 })
          expect(m.error, 'a dialog must be open').toBeUndefined()
          expect(m.viewport.height, 'the window must really be this tall').toBe(height)
          expect(
            m.dialogsOpen,
            'exactly the routed dialog (plus its parent, when stacked)'
          ).toBeGreaterThan(0)

          const bad = violations(m, { longContent: route.longContent })
          expect(bad, `${key}\n${JSON.stringify(m.card.rect)}`).toEqual([])

          // Once batch 1 lands the primitive, every card carries the shared cap.
          const token = await page.evaluate(() => {
            const cs = getComputedStyle(document.documentElement)
            return {
              layer: cs.getPropertyValue('--z-dialog').trim(),
              cap: cs.getPropertyValue('--dialog-max-h').trim()
            }
          })
          if (token.layer && token.cap) {
            const capPx = token.cap.endsWith('vh')
              ? (parseFloat(token.cap) / 100) * m.viewport.height
              : parseFloat(token.cap)
            const max = m.card.style['max-height']
            expect(max, `${key}: card has no max-height`).not.toBe('none')
            expect(
              parseFloat(max),
              `${key}: max-height ${max} exceeds ${token.cap}`
            ).toBeLessThanOrEqual(capPx + 0.5)
          }
        } finally {
          await closeRoute(route, ctx)
        }
      })
    }
  }

  // The six surfaces this net does NOT measure, each reported in the Playwright report with its
  // reason. Five cannot be opened from a seeded headless app; one is reachable and excluded by design.
  test('every surface the geometry net does not measure is listed with its reason', () => {
    const rest = ROUTES.filter((r: { reach: string }) => r.reach !== 'seed') as {
      id: string
      reach: string
      note?: string
    }[]
    const notReachable = rest.filter((r) => r.reach !== 'reference')
    const excluded = rest.filter((r) => r.reach === 'reference')
    expect(notReachable.map((r) => r.id).sort()).toEqual([
      'ContainersRemoveDialog',
      'HarnuModExternal',
      'ImageLightbox',
      'McpConfirmOverlay',
      'ReviewPane.submitConfirm'
    ])
    expect(excluded.map((r) => r.id)).toEqual(['CommandPalette'])
    for (const r of rest) expect(r.note, `${r.id} (${r.reach}) needs a reason`).toBeTruthy()
    // Visible in the Playwright report: the geometry of these is NOT proven by this run.
    for (const r of notReachable) {
      test
        .info()
        .annotations.push({ type: 'not-reachable-in-ci', description: `${r.id}: ${r.note}` })
    }
    // Reachable (Ctrl+K) but keeps its own shell by decision D6 — spec §5.4; never migrated.
    for (const r of excluded) {
      test
        .info()
        .annotations.push({ type: 'excluded-by-design', description: `${r.id}: ${r.note}` })
    }
  })

  test('the seeded world has BUG-184 shape: 33+ removable review rows and 16 refused', async () => {
    expect(seed.worktrees.length).toBeGreaterThanOrEqual(67)
    expect(seed.states.dirty.length).toBeGreaterThanOrEqual(33)
    expect(seed.states.locked.length + seed.states.nestedOuter.length).toBeGreaterThanOrEqual(16)
  })

  // The seed's INPUTS are not the finding — what the live dialog shows is. This pins, against the
  // running app, which worktree states reach the bulk dialog's refused section (spec §6.3 step 3):
  // locked and nested-worktree do; detached HEAD (filed as In use) and a plain merged worktree do not.
  for (const [id, rows, refused] of [
    [
      'CleanupBulkConfirmDialog#ready',
      () => seed.states.plain.length + seed.states.nestedInner.length,
      () => 0
    ],
    [
      'CleanupBulkConfirmDialog#review',
      () => seed.states.dirty.length,
      () => seed.states.locked.length + seed.states.nestedOuter.length
    ],
    [
      'CleanupBulkConfirmDialog#review-few',
      () => 1,
      () => seed.states.locked.length + seed.states.nestedOuter.length
    ]
  ] as const) {
    test(`${id} lists exactly the seeded rows and refused rows`, async () => {
      const route = SEEDED_ROUTES.find((r: { id: string }) => r.id === id)
      expect(route, `route ${id}`).toBeTruthy()
      const ctx = { page, app, seed }
      await route.open(ctx)
      try {
        expect(
          await page.locator('[data-testid="bulk-row"]').count(),
          `${id}: removable rows`
        ).toBe(rows())
        const refusedRows = page.locator('[data-testid="bulk-refused-row"]')
        expect(await refusedRows.count(), `${id}: refused rows`).toBe(refused())
        // Which states: only locked and nested-worktree, by their on-screen reason.
        const texts = (await refusedRows.allInnerTexts()).join('\n')
        const locked = (texts.match(/locked/gi) ?? []).length
        const nested = (texts.match(/another worktree or checkout/gi) ?? []).length
        expect(locked, `${id}: locked`).toBe(refused() === 0 ? 0 : seed.states.locked.length)
        expect(nested, `${id}: nested`).toBe(refused() === 0 ? 0 : seed.states.nestedOuter.length)
        // Detached worktrees never appear anywhere in the dialog.
        const dialog = await page.locator('[data-testid="bulk-dialog"]').innerText()
        for (const name of seed.states.detached)
          expect(dialog, `${id}: ${name}`).not.toContain(name)
      } finally {
        await closeRoute(route, ctx)
      }
    })
  }
})
