/**
 * T460 batch 0 — the UI route table (spec §6.3 "How each surface is reached").
 *
 * One entry per way of opening a dialog in the REAL app, driven like a user (role / aria-label /
 * data-testid selectors and keyboard shortcuts) — never through the `ui` store: a production build
 * has no handle to it (spec §2, §8.2), and the dialogs the baseline compares must be reached the
 * way an operator reaches them.
 *
 * A route is
 *   {
 *     id:     'CleanupBulkConfirmDialog#review'   // component name, `#variant` when one file has several states
 *     file:   'CleanupBulkConfirmDialog.vue'
 *     reach:  'seed' | 'needs-claude' | 'reference' | 'not-seedable'
 *     note?:  string                               // required for anything that is not `seed`
 *     longContent?: boolean                        // the seed fills the body: it MUST scroll
 *     open:   async ({ page, app, seed }) => void  // resolves once [role="dialog"] is visible and settled
 *     close?: async ({ page, app, seed }) => void  // default: Escape; must leave NO dialog open
 *   }
 *
 * `seed` is the object `seedDialogWorld()` returns (tests/e2e/ci/fixtures/dialog-seed.ts).
 * Every route is idempotent: after `close` the app is at rest, so routes run back-to-back in one
 * app instance in any order.
 */
import { ROUTES_FOLDER_GLOBAL } from './folder-global.mjs'
import { ROUTES_CLEANUP } from './cleanup.mjs'
import { ROUTES_BOARD_MISSIONS } from './board-missions.mjs'

export const ROUTES = [...ROUTES_FOLDER_GLOBAL, ...ROUTES_CLEANUP, ...ROUTES_BOARD_MISSIONS]

/**
 * Routes a headless `ci` launch can open with nothing but the seed. (The seed reaches everything
 * but four surfaces; see `reach` below.)
 */
export const SEEDED_ROUTES = ROUTES.filter((r) => r.reach === 'seed')

/**
 * Routes the before/after baseline measures: everything the seed reaches, plus the routes that also
 * need a real `claude` binary on PATH (`needs-claude`) — a developer machine has one, the CI runner
 * does not, so the geometry spec lists those as unreachable-in-CI with their reason.
 */
export const MEASURED_ROUTES = ROUTES.filter(
  (r) => r.reach === 'seed' || r.reach === 'needs-claude'
)

/** Default `close`: Escape, then wait until no dialog is left. */
export async function closeRoute(route, ctx) {
  if (route.close) await route.close(ctx)
  else await ctx.page.keyboard.press('Escape')
  await ctx.page.locator('[role="dialog"]').first().waitFor({ state: 'detached', timeout: 5000 })
}
