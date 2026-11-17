/**
 * T460 batch 0 — UI routes (spec §6.3 "How each surface is reached") for the Roadmap board and
 * Mission dialogs, driven against the REAL built app. Used by `scripts/dev/dialog-baseline.mjs`
 * and `tests/e2e/ci/dialog-geometry.spec.ts`.
 *
 *   id                          file                              how it is reached
 *   CardCreateModal             CardCreateModal.vue               folder menu → Roadmap board → "New card"
 *   CardDetailModal             CardDetailModal.vue               Roadmap board → click a card
 *   RoadmapBoard.dispatch       RoadmapBoard.vue                  Roadmap board → an AGENT-authored card's "Dispatch"
 *   MissionCloseConfirmDialog   MissionCloseConfirmDialog.vue     owner session selected → Topbar mission pill → Mission pane → Close mission…
 *   MissionHandoffDialog        MissionHandoffDialog.vue          a v4 mission's leading session selected → Topbar pill → Sessions → "Continue in a new session…"
 *
 * A route is `{ id, file, reach, note?, open({ page, app, seed }), close?({ page }) }`. `open`
 * drives the UI like a user (role / aria-label / data-testid / data-dsqa / data-test selectors,
 * keyboard) and resolves once a `[role="dialog"]` is visible and has finished its 140ms scale-in.
 * `close` defaults to {@link closeAllDialogs}. Routes are idempotent and order-independent: each
 * one first clears any stray dialog, then (re)establishes the state it needs.
 *
 * Three things a route needs that the seed does NOT put on disk are created here, on demand, by
 * writing files exactly like the seed does (never through `window.api`, never in `src/`):
 *
 *   1. an AGENT-authored roadmap card. Dispatching a HUMAN-authored card in an unblocked folder
 *      runs immediately under agent autonomy (it spawns a real `claude` session and shows no
 *      dialog), so the dispatch-confirm overlay is only reachable for `provenance.author: agent`.
 *   2. a transcript for the session that owns the seeded active mission, so the session appears in
 *      the sidebar and its Topbar mission pill can be clicked.
 *   3. two fresh finished missions written AFTER the first mission poll, because the app seeds its
 *      "already heard" memory silently on the first poll and only CUES (a bell entry) on a mission
 *      that appears later. The review dialog has no other entry point.
 *
 * Dropping a card onto Ready (the other way to reach the dispatch overlay) is deliberately NOT
 * used: it rewrites the card file's status, so it would not be repeatable.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The session that owns the seeded missions (tests/e2e/ci/fixtures/dialog-seed.ts). */
const MISSION_OWNER_SESSION = '00000000-0000-4000-8000-000000000001'

/** The session that leads the v4 mission the hand-off route writes (a v4 record is not in the seed). */
const V4_LEADER_SESSION = '00000000-0000-4000-8000-000000000020'

const FADE_MS = 400

// ---- generic helpers ----------------------------------------------------------------------

const dialogs = (page) => page.locator('[role="dialog"]')

/** Resolves once the newest dialog is visible and its scale-in animation has finished. */
async function dialogReady(page, timeout = 8000) {
  await dialogs(page).last().waitFor({ state: 'visible', timeout })
  await page.waitForTimeout(FADE_MS)
}

/**
 * Leaves no dialog open. Esc closes the topmost one (every Dialog but the dispatch overlay
 * listens on the window); the dispatch overlay only hears Esc with focus inside it, so its Cancel
 * button is activated first. The Cancel button is clicked through the DOM, NOT with a pointer
 * click: in a short window a card with no scroll region (the dispatch overlay, BUG-184's shape)
 * pushes its footer below the viewport, where a real click cannot reach it — and a route that
 * cannot close would poison every route after it. Throws if a dialog survives.
 */
export async function closeAllDialogs(page) {
  for (let i = 0; i < 6; i++) {
    if ((await dialogs(page).count()) === 0) return
    const pressed = await dialogs(page)
      .last()
      .evaluate((el) => {
        const cancel = [...el.querySelectorAll('button')].find(
          (b) => (b.textContent ?? '').trim() === 'Cancel'
        )
        cancel?.click()
        return !!cancel
      })
    if (!pressed) await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
  }
  if ((await dialogs(page).count()) > 0)
    throw new Error('a dialog is still open after closeAllDialogs')
}

/** Dismiss toasts that sit over the lower-right corner, and park the mouse (no hover cards). */
async function tidy(page) {
  const toast = page.locator('[role="region"][aria-live="polite"] button[aria-label="Dismiss"]')
  for (let i = 0; i < 4 && (await toast.count()) > 0; i++)
    await toast
      .first()
      .click()
      .catch(() => {})
  await page.mouse.move(640, 450)
}

/** Clear stray dialogs and a stray bell popover (the Mission pane keeps its open state between routes). */
async function reset(page) {
  await closeAllDialogs(page)
  const bell = page.locator('[data-dsqa="topbar-bell"]')
  if ((await bell.getAttribute('aria-expanded').catch(() => 'false')) === 'true') await bell.click()
  await tidy(page)
}

/** The sidebar row of the seeded repo's main checkout, expanding its repo group when collapsed. */
async function repoRow(page, seed) {
  const row = page.locator(`[data-folder-path="${seed.repo}"] button.sidebar-row`).first()
  if (!(await row.isVisible().catch(() => false))) {
    await page.locator('button.sidebar-row').first().click()
    await row.waitFor({ state: 'visible', timeout: 5000 })
    await page.waitForTimeout(500)
  }
  return row
}

// ---- the Roadmap board ----------------------------------------------------------------------

const BOARD_CARD = 'article[draggable="true"]'
const AGENT_CARD_SLUG = 'T9004-seed-agent-card'
const AGENT_CARD_TITLE = 'Seed agent card'

/** An agent-authored, Ready card: the only kind whose Dispatch asks for a confirm (see header). */
function ensureAgentCard(seed) {
  const dir = join(seed.repo, '.harnu', 'memory', 'roadmap')
  const file = join(dir, `${AGENT_CARD_SLUG}.md`)
  if (existsSync(file)) return false
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    file,
    [
      '---',
      'id: T9004',
      `title: ${AGENT_CARD_TITLE}`,
      'status: ready',
      'kind: feature',
      'complexity: standard',
      'substrate: session',
      'provenance:',
      '  author: agent',
      '  at: 2026-01-15T12:00:00+00:00',
      '  branch: main',
      '---',
      '## Objective',
      'A card an agent raised: dispatching it needs a human confirm.',
      ''
    ].join('\n')
  )
  return true
}

/** Opens the repo's Roadmap board (folder menu → "Roadmap board") unless it is already showing. */
async function openBoard({ page, seed }) {
  await reset(page)
  if (
    await page
      .locator(BOARD_CARD)
      .first()
      .isVisible()
      .catch(() => false)
  )
    return
  const row = await repoRow(page, seed)
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Roadmap board' }).click()
  await page.locator(BOARD_CARD).first().waitFor({ state: 'visible', timeout: 8000 })
  await tidy(page)
}

const card = (page, title) => page.locator(BOARD_CARD, { hasText: title }).first()

// ---- missions ---------------------------------------------------------------------------------

/** Writes a session transcript so the mission owner shows up in the sidebar (no `claude` needed). */
function ensureOwnerTranscript(seed) {
  const slug = seed.repo.replace(/[^a-zA-Z0-9]/g, '-')
  const dir = join(seed.userData, '.claude', 'projects', slug)
  const file = join(dir, `${MISSION_OWNER_SESSION}.jsonl`)
  if (existsSync(file)) return false
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'seed session' },
      cwd: seed.repo,
      sessionId: MISSION_OWNER_SESSION,
      timestamp: '2026-01-15T12:00:00.000Z',
      uuid: '00000000-0000-4000-8000-0000000000f1',
      version: '2.1.0'
    }) + '\n'
  )
  return true
}

/**
 * A v4 mission whose open leader is {@link V4_LEADER_SESSION}, and that session's transcript, written once
 * per world exactly like the seed writes files. A v4 record lives in the repo's `.harnu/missions-v4/`; the
 * seed's missions are v3, so the hand-off route cannot borrow one.
 */
function ensureV4Mission(seed) {
  const slug = seed.repo.replace(/[^a-zA-Z0-9]/g, '-')
  const projectDir = join(seed.userData, '.claude', 'projects', slug)
  const transcript = join(projectDir, `${V4_LEADER_SESSION}.jsonl`)
  if (!existsSync(transcript)) {
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'seed v4 leader' },
        cwd: seed.repo,
        sessionId: V4_LEADER_SESSION,
        timestamp: '2026-01-15T12:00:00.000Z',
        uuid: '00000000-0000-4000-8000-0000000000f2',
        version: '2.1.0'
      }) + '\n'
    )
  }
  const dir = join(seed.repo, '.harnu', 'missions-v4')
  const file = join(dir, 'mnt-00000020-seed-v4-hand-off.md')
  if (existsSync(file)) return false
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    file,
    [
      '---',
      'schemaVersion: 4',
      'id: mnt-00000020',
      'title: Score a spec with a test set',
      'doneWhen: A score report exists for the whole test set',
      'status: open',
      'milestones:',
      '  - id: mls-1',
      '    title: A tool that scores a spec',
      '    optional: false',
      '    waitsFor: null',
      'steps:',
      '  - id: stp-1',
      '    milestone: mls-1',
      '    title: Write the plan for the scoring tool',
      '    acs:',
      '      - id: ac-1',
      '        text: The plan names the test files',
      '        by: operator',
      '    links: []',
      '    blockers: []',
      'sessions:',
      '  - id: 00000000-0000-4000-8000-000000000021',
      '    role: worked',
      "    from: '2026-01-14T09:00:00.000Z'",
      "    to: '2026-01-15T09:00:00.000Z'",
      '    stoppedAt:',
      '      step: stp-1',
      `  - id: ${V4_LEADER_SESSION}`,
      '    role: leads',
      "    from: '2026-01-15T09:00:00.000Z'",
      '    to: null',
      'links: []',
      'blockers: []',
      '---',
      '# Log',
      ''
    ].join('\n')
  )
  return true
}

/** Selects the v4 mission's leading session so the v4 Topbar pill renders; the pill opens the Mission pane. */
async function selectV4Leader({ page, seed }) {
  ensureV4Mission(seed)
  const session = page.locator(`button[data-session-id="${V4_LEADER_SESSION}"]`)
  const row = await repoRow(page, seed)
  await session.waitFor({ state: 'attached', timeout: 15000 })
  const reachable = () =>
    session.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return r.height > 0 && !!top && el.contains(top)
    })
  if (!(await reachable())) {
    await row.click()
    await page.waitForTimeout(800)
  }
  await session.click()
  await pill(page).waitFor({ state: 'visible', timeout: 15000 })
}

/** The Topbar mission pill of the selected session, or `null` when none is showing. */
const pill = (page) => page.locator('[data-dsqa^="topbar-pill--"]').first()

/** Selects the seeded owner session so its mission pill renders in the Topbar. */
async function selectOwnerSession({ page, seed }) {
  if (
    await pill(page)
      .isVisible()
      .catch(() => false)
  )
    return
  ensureOwnerTranscript(seed)
  const row = await repoRow(page, seed)
  const session = page.locator(`button[data-session-id="${MISSION_OWNER_SESSION}"]`)
  // The session rows sit in the folder's collapsible child list. A collapsed list is still
  // "visible" to Playwright (zero height, overflow shown), so ask the browser whether the row is
  // actually the topmost thing at its own centre; expand the folder when it is not.
  await session.waitFor({ state: 'attached', timeout: 15000 })
  const reachable = () =>
    session.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return r.height > 0 && !!top && el.contains(top)
    })
  if (!(await reachable())) {
    await row.click()
    await page.waitForTimeout(800)
  }
  await session.click()
  await pill(page).waitFor({ state: 'visible', timeout: 15000 })
}

// ---- the routes -------------------------------------------------------------------------------

/** @type {Array<{ id: string, file: string, reach: 'seed' | 'not-seedable', note?: string, open: (ctx: { page: import('@playwright/test').Page, app: import('@playwright/test').ElectronApplication, seed: any }) => Promise<void>, close?: (ctx: { page: import('@playwright/test').Page }) => Promise<void> }>} */
export const ROUTES_BOARD_MISSIONS = [
  {
    id: 'CardCreateModal',
    file: 'CardCreateModal.vue',
    reach: 'seed',
    open: async (ctx) => {
      await openBoard(ctx)
      await ctx.page.getByRole('button', { name: /new card/i }).click()
      await dialogReady(ctx.page)
    },
    close: async ({ page }) => closeAllDialogs(page)
  },
  {
    id: 'CardDetailModal',
    file: 'CardDetailModal.vue',
    reach: 'seed',
    open: async (ctx) => {
      await openBoard(ctx)
      await card(ctx.page, 'Seed ready card').getByText('Seed ready card').click()
      await dialogReady(ctx.page)
    },
    close: async ({ page }) => closeAllDialogs(page)
  },
  {
    id: 'RoadmapBoard.dispatch',
    file: 'RoadmapBoard.vue',
    reach: 'seed',
    note:
      'Needs an agent-authored card (written on demand by this route): a human-authored card ' +
      'dispatches immediately with no dialog. Cancel is clicked to close — the overlay only hears Esc with focus inside it.',
    open: async (ctx) => {
      const { page, seed } = ctx
      await reset(page)
      ensureAgentCard(seed)
      await openBoard(ctx)
      const agentCard = card(page, AGENT_CARD_TITLE)
      await agentCard.waitFor({ state: 'visible', timeout: 10000 })
      await agentCard.getByRole('button', { name: 'Dispatch' }).click()
      await dialogReady(page)
    },
    close: async ({ page }) => closeAllDialogs(page)
  },
  {
    id: 'MissionCloseConfirmDialog',
    file: 'MissionCloseConfirmDialog.vue',
    reach: 'seed',
    note:
      'Needs the mission OWNER session in the sidebar: the route writes a transcript for it (the seed does not) and selects it. ' +
      "The seeded mission is a v3 file: since the cut-over its pill opens the Mission pane like any record, and the pane's " +
      '"Close mission…" opens the dialog. The pane keeps its open state between runs in one app, so it is opened only when it is closed. ' +
      'Selecting a session starts a `claude --resume` PTY; the pill and the pane do not depend on that process.',
    open: async (ctx) => {
      const { page } = ctx
      await reset(page)
      await selectOwnerSession(ctx)
      await tidy(page)
      const pane = page.locator('[data-dsqa="mission-pane"]')
      if (!(await pane.isVisible().catch(() => false))) await pill(page).click()
      await page.locator('[data-test="mission-close-open"]').click()
      await page
        .locator('[data-test="mission-close-confirm"]')
        .waitFor({ state: 'visible', timeout: 8000 })
      await dialogReady(page)
    },
    close: async ({ page }) => closeAllDialogs(page)
  },
  {
    id: 'MissionHandoffDialog',
    file: 'MissionHandoffDialog.vue',
    reach: 'seed',
    note:
      'Needs a v4 mission, which the seed does not hold: the route writes one (and its leading session) into the seeded repo. ' +
      'The pill toggles the Mission pane, whose Sessions row opens the confirmation. Nothing is confirmed: the dialog is only opened and closed.',
    open: async (ctx) => {
      const { page } = ctx
      await reset(page)
      await selectV4Leader(ctx)
      await tidy(page)
      const pane = page.locator('[data-dsqa="mission-pane"]')
      if (!(await pane.isVisible().catch(() => false))) await pill(page).click()
      // Idempotent: the Sessions row keeps its open state between runs in one app (the 900px run leaves it
      // open for the 560px one), so it is opened only when it is not open.
      const toggle = page.locator('[data-test="sessions-toggle"]')
      await toggle.waitFor({ state: 'visible', timeout: 15000 })
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
      await page.locator('[data-test="handoff-open"]').click()
      await page
        .locator('[data-test="handoff-dialog"]')
        .waitFor({ state: 'visible', timeout: 8000 })
      await dialogReady(page)
    },
    close: async ({ page }) => closeAllDialogs(page)
  }
]
