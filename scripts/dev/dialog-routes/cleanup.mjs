/**
 * T460 batch 0 — UI routes to the Cleanup dialogs (spec §6.3, "How each surface is reached").
 *
 * Every route drives the REAL built app the way a user does (data-testid / data-dsqa selectors,
 * keyboard) — never a store or `window.api` handle, because a production build has none (spec §8.2).
 *
 * Route contract (shared by all `scripts/dev/dialog-routes/*.mjs`):
 *   - `open({ page, app, seed })` resolves once `[role="dialog"]` is visible and its entrance
 *     animation has settled;
 *   - `close({ page })` (default: Escape) leaves NO dialog open and the app at its resting state;
 *     here the Cleanup takeover itself stays open, with nothing ticked, so routes can run
 *     back-to-back in one app instance in any order;
 *   - `reach` is `'seed'` (reachable from `seedDialogWorld()`) or `'not-seedable'` (`open` throws
 *     with the reason; the driver reports it instead of failing).
 *
 * World facts the routes rely on (from `tests/e2e/ci/fixtures/dialog-seed.ts`, measured by running
 * it): the "Clean N ready" hero opens a READY-mode confirm with 0 refused rows; ticking every row of
 * the Needs-review list and pressing Remove opens a REVIEW-mode confirm with the dirty (removable)
 * rows plus the locked and nested-worktree ones in its "won't be removed" group; the 3 merged
 * leftover branches populate "Other leftovers" and its Sweep button.
 */
/** Entrance animation (`.anim-fade-in-scale`, 140ms) plus a frame. */
const SETTLE_MS = 300

const DIALOG = '[role="dialog"]'

/** Open the Cleanup takeover (footer pill) and wait for its first scan; idempotent. */
async function ensureCleanup(page) {
  if (
    !(await page
      .locator('[data-testid="cleanup-toolbar"]')
      .isVisible()
      .catch(() => false))
  ) {
    await page.locator('[data-dsqa="cleanup-footer-pill"]').click()
  }
  // The scan is done once the summary is no longer "scanning" and a body (hero or all-clean) rendered.
  await page.locator('[data-testid="cleanup-body"]').waitFor({ state: 'visible', timeout: 60_000 })
  await page
    .locator('[data-testid="cleanup-summary-scanning"]')
    .waitFor({ state: 'detached', timeout: 60_000 })
  await page.locator('[data-testid="hero-clean"]').waitFor({ state: 'visible', timeout: 60_000 })
  // The first-cycle banner is informational; dismissing it keeps layout identical between runs.
  const dismiss = page.locator('[data-testid="first-dismiss"]')
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click()
}

/** Untick everything (the selection bar's Clear), so a route never inherits a selection. */
async function clearSelection(page) {
  const clear = page.locator('[data-testid="sel-clear"]')
  if (await clear.isVisible().catch(() => false)) await clear.click()
}

/** Tick every row of the Needs-review list. */
async function tickAllReview(page) {
  await clearSelection(page)
  const checks = page.locator('[data-testid="review-check"]')
  const n = await checks.count()
  for (let i = 0; i < n; i++) await checks.nth(i).click()
  await page.locator('[data-testid="selection-bar"]').waitFor({ state: 'visible' })
}

async function waitDialog(page, testid) {
  await page
    .locator(testid ? `[data-testid="${testid}"]` : DIALOG)
    .first()
    .waitFor({ state: 'visible' })
  await page.waitForTimeout(SETTLE_MS)
}

/** Escape, wait for the dialog to unmount, then untick whatever the route ticked. */
async function closeAndReset({ page }) {
  await page.keyboard.press('Escape')
  await page.locator(DIALOG).first().waitFor({ state: 'detached', timeout: 30_000 })
  // Dehydrate rescans on close; let the takeover settle before the next route.
  await page
    .locator('[data-testid="cleanup-summary-scanning"]')
    .waitFor({ state: 'detached', timeout: 60_000 })
    .catch(() => {})
  await clearSelection(page)
}

/** @typedef {{ page: import('@playwright/test').Page, app: import('@playwright/test').ElectronApplication, seed: any }} RouteCtx */

export const ROUTES_CLEANUP = [
  {
    id: 'CleanupBulkConfirmDialog#ready',
    file: 'CleanupBulkConfirmDialog.vue',
    reach: 'seed',
    longContent: true,
    note: 'Hero "Clean N ready": every ready worktree, no refused group.',
    /** @param {RouteCtx} ctx */
    async open({ page }) {
      await ensureCleanup(page)
      await clearSelection(page)
      await page.locator('[data-testid="hero-clean"]').click()
      await waitDialog(page, 'bulk-dialog')
    },
    close: closeAndReset
  },
  {
    id: 'CleanupBulkConfirmDialog#review',
    file: 'CleanupBulkConfirmDialog.vue',
    reach: 'seed',
    longContent: true,
    note: 'Tick every Needs-review row, then Remove: removable (dirty) rows plus a "won\'t be removed" group of locked and nested worktrees — the BUG-184 shape.',
    /** @param {RouteCtx} ctx */
    async open({ page }) {
      await ensureCleanup(page)
      await tickAllReview(page)
      await page.locator('[data-testid="sel-remove"]').click()
      await waitDialog(page, 'bulk-dialog')
    },
    close: closeAndReset
  },
  {
    id: 'DehydrateConfirmDialog',
    file: 'DehydrateConfirmDialog.vue',
    reach: 'seed',
    note: 'Tick the Needs-review rows, then Dehydrate. The seed leaves an ignored node_modules in every dirty worktree — that is what it offers to remove.',
    /** @param {RouteCtx} ctx */
    async open({ page }) {
      await ensureCleanup(page)
      await tickAllReview(page)
      await page.locator('[data-testid="sel-dehydrate"]').click()
      await waitDialog(page, 'dehydrate-confirm')
    },
    close: closeAndReset
  },
  {
    id: 'SweepConfirmDialog',
    file: 'SweepConfirmDialog.vue',
    reach: 'seed',
    note: 'Other leftovers → "Sweep N" (the seed has 3 merged local branches with no worktree).',
    /** @param {RouteCtx} ctx */
    async open({ page }) {
      await ensureCleanup(page)
      await clearSelection(page)
      const sweep = page.locator('[data-testid="cleanup-other-sweep"]')
      await sweep.scrollIntoViewIfNeeded()
      await sweep.click()
      await waitDialog(page)
    },
    close: closeAndReset
  },
  {
    id: 'ContainersRemoveDialog',
    file: 'ContainersRemoveDialog.vue',
    reach: 'not-seedable',
    note: 'Containers takeover → a stack → Remove. Needs a stopped Docker stack that Harnu attributes to a folder; the seed never creates Docker resources (CI must not depend on them).',
    async open() {
      throw new Error(
        'ContainersRemoveDialog is not seedable: it needs a Docker stack (spec §6.3 step 3)'
      )
    }
  }
]
