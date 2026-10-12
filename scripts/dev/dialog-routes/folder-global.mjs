/**
 * T460 batch 0 — UI routes (spec §6.3 "How each surface is reached") for the folder-menu and the
 * global dialogs. Every route drives the real built app the way a user does — role / aria-label /
 * data-testid / data-folder-path selectors and keyboard shortcuts, never `window.api` or a store
 * handle (spec §8.2) — and resolves once exactly the dialog it names is on screen and settled.
 *
 * Route contract (shared with the other `dialog-routes/*.mjs` files):
 *
 *   { id, file, reach, note?, open({ page, app, seed }), close?({ page }) }
 *
 *   - `reach: 'seed'`          reachable on a fresh seeded world (`seedDialogWorld()`).
 *   - `reach: 'reference'`     reachable, but the surface keeps its own shell (spec D6): it is
 *                              measured for reference only, never migrated.
 *   - `reach: 'not-seedable'`  cannot be opened in a headless `ci` launch; `open` throws.
 *   - `close` defaults to {@link closeAllDialogs}; it MUST leave no dialog open so the next route
 *     can run in the same app instance, in any order.
 *
 * Selector notes (what is brittle): folder rows are found by `[data-folder-path]` (the folder's
 * absolute path, so it depends on the seed); the repo group header is the sidebar row that carries
 * the git-branch icon; menu items are found by their English accessible name — a locale change
 * would break them, which is why the driver runs in `en`.
 */

/** Selector for an open dialog card. */
const DIALOG = '[role="dialog"]'

/** Wait for the open-animation (140 ms scale-in) and any post-open focus move to settle. */
const SETTLE_MS = 300

/**
 * Wait until a dialog is visible and settled.
 * @param {import('@playwright/test').Page} page
 */
async function settleDialog(page) {
  await page.locator(DIALOG).last().waitFor({ state: 'visible' })
  await page.waitForTimeout(SETTLE_MS)
}

/** Number of dialog cards currently in the DOM. */
async function dialogCount(page) {
  return page.locator(DIALOG).count()
}

/**
 * Press Escape until no dialog (and no folder/group menu) is left. Stacked surfaces (a confirm
 * over Settings) need more than one press; the loop is bounded so a dialog that ignores Escape
 * fails loudly instead of hanging the run.
 * @param {{ page: import('@playwright/test').Page }} ctx
 */
export async function closeAllDialogs({ page }) {
  for (let i = 0; i < 4; i++) {
    if ((await dialogCount(page)) === 0) break
    await page.keyboard.press('Escape')
    await page.waitForTimeout(SETTLE_MS)
  }
  if ((await dialogCount(page)) !== 0) {
    throw new Error('closeAllDialogs: a dialog is still open after 4 Escape presses')
  }
  // A context menu left open would swallow the next route's first click.
  await dismissMenus(page)
}

/** Close any open folder / group context menu (they dismiss on Escape or an outside mousedown). */
async function dismissMenus(page) {
  if ((await page.locator('[role="menu"]').count()) > 0) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
  }
}

/**
 * Activate a menu item from the keyboard. The folder menu is a fixed-position popover that is NOT
 * scrollable: at a 560px window its lower entries ("Remove worktree", …) sit below the viewport
 * and a pointer click cannot reach them, but a user can still arrow down to them. `roving` menus
 * (the folder menu) keep their own focus index and run Enter on THAT entry, so focusing the target
 * and pressing Enter would activate the wrong row: step with ArrowDown until the target holds
 * focus, then press Enter. A plain menu (the group menu) is native buttons, so focus + Enter does.
 * @param {import('@playwright/test').Locator} item
 * @param {import('@playwright/test').Page} page
 * @param {{ roving?: boolean }} [opts]
 */
async function activate(item, page, { roving = false } = {}) {
  await item.waitFor({ state: 'attached' })
  if (!roving) {
    await item.focus()
  } else {
    const handle = await item.elementHandle()
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate((el) => el === document.activeElement, handle)) break
      await page.keyboard.press('ArrowDown')
    }
    if (!(await page.evaluate((el) => el === document.activeElement, handle))) {
      throw new Error('activate: could not reach the menu item with ArrowDown')
    }
  }
  await page.keyboard.press('Enter')
}

/**
 * Right-click a pinned folder / worktree row in the sidebar and click a menu item.
 * @param {import('@playwright/test').Page} page
 * @param {string} folderPath absolute path of the folder row (`seed.repo`, `seed.linkedWorktree`, …)
 * @param {string | RegExp} item accessible name of the menu item
 */
async function folderMenu(page, folderPath, item) {
  await dismissMenus(page)
  const row = page.locator(`[data-folder-path="${folderPath}"] > button`).first()
  await row.waitFor({ state: 'visible' })
  await row.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Folder actions' })
  await menu.waitFor({ state: 'visible' })
  await activate(menu.getByRole('menuitem', { name: item }).first(), page, { roving: true })
}

/**
 * Open the "New worktree…" entry: it sits in a flyout under the git group of the folder menu
 * on some builds and at the top level on others, so click whichever shows.
 */
async function newWorktreeItem(page, folderPath) {
  await dismissMenus(page)
  const row = page.locator(`[data-folder-path="${folderPath}"] > button`).first()
  await row.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Folder actions' })
  await menu.waitFor({ state: 'visible' })
  const direct = menu.getByRole('menuitem', { name: /New worktree/ })
  if ((await direct.count()) === 0) {
    // Flyout parent: hover / click the parent entry that owns the child.
    await activate(menu.getByRole('menuitem', { name: /worktree/i }).first(), page, {
      roving: true
    })
  }
  await activate(page.getByRole('menuitem', { name: /New worktree/ }).first(), page, {
    roving: true
  })
}

/**
 * The repo group header: the sidebar row that carries the git-branch icon and the repo label
 * (the first row of the folder tree). Right-click opens the "Group actions" menu.
 */
async function groupHeader(page) {
  return page.locator('aside button.sidebar-row:has(svg.lucide-git-branch)').first()
}

/** @type {Array<{ id: string, file: string, reach: 'seed' | 'reference' | 'not-seedable', note?: string, open: (ctx: any) => Promise<void>, close?: (ctx: any) => Promise<void> }>} */
export const ROUTES_FOLDER_GLOBAL = [
  {
    id: 'AddFolderDialog',
    file: 'AddFolderDialog.vue',
    reach: 'seed',
    note: 'Ctrl+O (the app binds "Cmd+O"; on Linux the same shortcut is Ctrl+O). Needs focus outside any input.',
    async open({ page }) {
      await page.keyboard.press('Control+o')
      await settleDialog(page)
    }
  },
  {
    id: 'RenameFolderDialog',
    file: 'RenameFolderDialog.vue',
    reach: 'seed',
    note: 'Folder menu on the pinned `www` main checkout → "Rename…".',
    async open({ page, seed }) {
      await folderMenu(page, seed.repo, /^Rename/)
      await settleDialog(page)
    }
  },
  {
    id: 'RenameRepoDialog',
    file: 'RenameRepoDialog.vue',
    reach: 'seed',
    note: 'Right-click the repo group header → "Rename group".',
    async open({ page }) {
      await dismissMenus(page)
      const header = await groupHeader(page)
      await header.waitFor({ state: 'visible' })
      await header.click({ button: 'right' })
      const menu = page.getByRole('menu', { name: 'Group actions' })
      await menu.waitFor({ state: 'visible' })
      await activate(menu.getByRole('menuitem', { name: 'Rename group' }), page)
      await settleDialog(page)
    }
  },
  {
    id: 'NewFolderDialog',
    file: 'NewFolderDialog.vue',
    reach: 'seed',
    note: 'Folder menu on `www` → "New folder…".',
    async open({ page, seed }) {
      await folderMenu(page, seed.repo, /^New folder/)
      await settleDialog(page)
    }
  },
  {
    id: 'NewSessionDialog',
    file: 'NewSessionDialog.vue',
    reach: 'seed',
    note: 'The "+" (New session) button on the `www` folder row. One of five openers (spec §1.2).',
    async open({ page, seed }) {
      const row = page.locator(`[data-folder-path="${seed.repo}"] > button`).first()
      await row.hover()
      await row.getByRole('button', { name: 'New session' }).click()
      await settleDialog(page)
    }
  },
  {
    id: 'OpenSubfolderDialog',
    file: 'OpenSubfolderDialog.vue',
    reach: 'seed',
    note: 'Folder menu on `www` → "Open subfolder…".',
    async open({ page, seed }) {
      await folderMenu(page, seed.repo, /^Open subfolder/)
      await settleDialog(page)
    }
  },
  {
    id: 'NewWorktreeDialog',
    file: 'NewWorktreeDialog.vue',
    reach: 'seed',
    note: 'Folder menu on `www` → "New worktree…" (form phase; the dry-run / stepper phases are not driven).',
    async open({ page, seed }) {
      await newWorktreeItem(page, seed.repo)
      await settleDialog(page)
    }
  },
  {
    id: 'RemoveWorktreeDialog',
    file: 'RemoveWorktreeDialog.vue',
    reach: 'seed',
    note: 'Folder menu on a LINKED worktree row (`seed.linkedWorktree`) → "Remove worktree". Never confirmed.',
    async open({ page, seed }) {
      await folderMenu(page, seed.linkedWorktree, /^Remove worktree/)
      await settleDialog(page)
    }
  },
  {
    id: 'MemoryLocationDialog',
    file: 'MemoryLocationDialog.vue',
    reach: 'seed',
    note: 'Folder menu on `www` → "Store memory in…".',
    async open({ page, seed }) {
      await folderMenu(page, seed.repo, /^Store memory in/)
      await settleDialog(page)
    }
  },
  {
    id: 'ClaudeBootDialog',
    file: 'ClaudeBootDialog.vue',
    reach: 'seed',
    note: 'Folder menu on `www` → "Startup options…". Autosaves: the driver only opens and closes it.',
    async open({ page, seed }) {
      await folderMenu(page, seed.repo, /^Startup options/)
      await settleDialog(page)
    }
  },
  {
    id: 'SettingsDialog',
    file: 'SettingsDialog.vue',
    reach: 'seed',
    note: 'The sidebar gear (aria-label "Settings", or "Settings — update available" while a changelog is unread).',
    async open({ page }) {
      await page
        .locator('aside footer')
        .getByRole('button', { name: /^Settings/ })
        .click()
      await settleDialog(page)
    }
  },
  {
    id: 'HarnuModExternal',
    file: 'HarnuModExternal.vue',
    reach: 'seed',
    note:
      'Settings → Mods → "Advanced" → "outside Harnu" switch → confirm. Stacks OVER Settings, so `close` ' +
      'closes both. The switch is disabled until the Harnu mod is loaded (companion on); `open` throws a ' +
      'descriptive error when that is the case.',
    async open({ page }) {
      await page
        .locator('aside footer')
        .getByRole('button', { name: /^Settings/ })
        .click()
      await settleDialog(page)
      await page.getByRole('tab', { name: 'Mods' }).click()
      await page.locator('[data-testid="mods-external-advanced"]').click()
      const toggle = page.locator('[data-testid="mods-external-toggle"]')
      await toggle.waitFor({ state: 'visible' })
      if (await toggle.isDisabled()) {
        throw new Error(
          'HarnuModExternal: the outside-Harnu switch is disabled (the Harnu mod is not loaded in this app instance)'
        )
      }
      await toggle.click()
      await page.locator('[data-testid="mods-external-confirm"]').waitFor({ state: 'visible' })
      await page.waitForTimeout(SETTLE_MS)
    }
  },
  {
    id: 'CommandPalette',
    file: 'CommandPalette.vue',
    reach: 'reference',
    note: 'Ctrl+K. Keeps its own shell (spec D6); measured for reference only.',
    async open({ page }) {
      await page.keyboard.press('Control+k')
      await settleDialog(page)
    }
  }
]
