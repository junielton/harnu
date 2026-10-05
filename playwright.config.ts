import { defineConfig } from '@playwright/test'

/**
 * Playwright config for the e2e track (T05 track 2). Two projects:
 *  - `smoke` — the interactive dev specs that `connectOverCDP` to a running
 *    `npm run dev` (need a live/authenticated Claude, a subscription, a populated
 *    `~/.claude`). LOCAL ONLY — run with `npm run e2e`.
 *  - `ci` — the subscription-free specs under `tests/e2e/ci/` that
 *    `_electron.launch()` the built app headless. Run in CI under xvfb with
 *    `npm run e2e:ci`.
 *
 * CRITICAL: Playwright's default `testMatch` also picks up `*.test.ts`, which
 * would sweep the ~100 vitest unit tests. Restrict to `.spec.ts` so the two
 * runners stay mutually exclusive (vitest = `*.test.ts`, playwright = `*.spec.ts`).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false, // specs share the real app / processes
  workers: 1,
  timeout: 60_000,
  // `list` for live CI logs + an HTML report so a failed e2e is inspectable
  // from the uploaded artifact (T65 AC4). `outputDir` collects per-test files
  // (traces/screenshots) the CI job uploads on failure.
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  // Auto-capture for the `page`-fixture smoke specs. The electron `ci` spec
  // manages its own window, so it captures its trace/screenshot explicitly.
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    // Local smoke: connectOverCDP against `npm run dev`. NOT run in CI.
    { name: 'smoke', testIgnore: /\/ci\// },
    // CI headless: only the `_electron.launch()` specs under tests/e2e/ci/.
    { name: 'ci', testMatch: /\/ci\/.*\.spec\.ts$/ }
  ]
})
