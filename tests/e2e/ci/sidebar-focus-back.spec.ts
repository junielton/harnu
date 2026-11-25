import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './fixtures/launch-app'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Sidebar redesign S-5 — the "All folders" back row of Focus. Whatever the width,
 * the counts that need the operator stay readable, and the keyboard keeps its
 * place going in and out. jsdom has no box model and no native key activation, so
 * both are driven in the built app. Requires `npm run build` first.
 */

/** Two other folders need the operator and two failed, so both counts read as plurals. */
const FOLDERS = [
  { name: 'api-gateway', state: null },
  { name: 'portal', state: 'needs-input' },
  { name: 'web-api', state: 'needs-input' },
  { name: 'example-web', state: 'failed' },
  { name: 'proj', state: 'failed' }
] as const

const id = (index: number): string => `aaaaaaa${index}-0000-4000-8000-000000000001`

interface VueApp {
  config: {
    globalProperties: {
      $i18n: { locale: string }
      $pinia: {
        _s: Map<
          string,
          { sidebarWidth: number; findSessionById(id: string): { taskState?: string } | null }
        >
      }
    }
  }
}

let root = ''
let app: ElectronApplication
let page: Page

function seed(): string {
  const home = mkdtempSync(join(tmpdir(), 'harnu-focus-back-'))
  const projects = FOLDERS.map(({ name }, index) => {
    const path = join(home, 'Workspace', 'org', name)
    mkdirSync(path, { recursive: true })
    const dir = join(home, '.claude', 'projects', path.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    const lines = [
      {
        type: 'user',
        message: { role: 'user', content: `Work in ${name}` },
        cwd: path,
        sessionId: id(index),
        timestamp: new Date().toISOString(),
        uuid: `${id(index).slice(0, 8)}-0000-4000-8000-0000000000f1`,
        version: '2.1.0'
      }
    ]
    writeFileSync(
      join(dir, `${id(index)}.jsonl`),
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
    )
    return { path, alias: name, addedAt: new Date().toISOString(), worktrees: [] }
  })
  writeFileSync(
    join(home, 'projects.json'),
    JSON.stringify({ version: 1, projects, hiddenPaths: [] })
  )
  return home
}

const head = (name: string): ReturnType<Page['locator']> =>
  page.locator('[data-folder-head]').filter({ hasText: name })

async function setWidthAndLocale(width: number, locale: string): Promise<void> {
  await page.evaluate(
    ([width, locale]) => {
      const vue = (document.querySelector('#app') as unknown as { __vue_app__: VueApp }).__vue_app__
      vue.config.globalProperties.$pinia._s.get('layout')!.sidebarWidth = width as number
      vue.config.globalProperties.$i18n.locale = locale as string
    },
    [width, locale] as const
  )
  await page.waitForTimeout(400)
}

/** A failed test restarts the worker and its app, so no test leans on the one before it. */
async function ensureFocused(): Promise<void> {
  if ((await page.locator('[data-focus-back]').count()) > 0) return
  await head('api-gateway').hover()
  await head('api-gateway').locator('[data-focus-button]').click()
}

/** How each phrase of the back row is drawn: whole on screen, or cut by a box around it. */
function phrases(
  texts: string[]
): Promise<Array<{ text: string; whole: boolean; line: number } | null>> {
  return page.locator('[data-focus-back]').evaluate((row, texts) => {
    const nodes: Text[] = []
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
    const all = nodes.map((n) => n.data).join('')
    // A start on a boundary belongs to the node that follows, an end to the node before.
    const at = (offset: number, end = false): [Text, number] => {
      for (const node of nodes) {
        if (offset < node.data.length || (end && offset === node.data.length)) return [node, offset]
        offset -= node.data.length
      }
      throw new Error('offset past the row')
    }
    const box = row.getBoundingClientRect()
    return texts.map((text) => {
      const start = all.indexOf(text)
      if (start < 0) return null
      const range = document.createRange()
      range.setStart(...at(start))
      range.setEnd(...at(start + text.length, true))
      const r = range.getBoundingClientRect()
      let whole = r.width > 0 && r.left >= box.left && r.right <= box.right + 0.5
      whole &&= r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5
      for (let el = range.startContainer.parentElement; el && el !== row; el = el.parentElement) {
        if (getComputedStyle(el).overflowX === 'visible') continue
        const clip = el.getBoundingClientRect()
        whole &&= r.left >= clip.left - 0.5 && r.right <= clip.right + 0.5
      }
      return { text, whole, line: Math.round(r.top - box.top) }
    })
  }, texts)
}

test.beforeAll(async () => {
  root = seed()
  app = await launchApp({ userData: root })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)
  )
  await expect(page.locator('[data-session-row]')).toHaveCount(FOLDERS.length, { timeout: 30_000 })
  await page.evaluate(
    (states) => {
      const vue = (document.querySelector('#app') as unknown as { __vue_app__: VueApp }).__vue_app__
      const sessions = vue.config.globalProperties.$pinia._s.get('sessions')!
      for (const [sessionId, state] of states) {
        sessions.findSessionById(sessionId)!.taskState = state
      }
    },
    FOLDERS.flatMap((folder, index) =>
      folder.state ? [[id(index), folder.state] as [string, string]] : []
    )
  )
})

test.afterAll(async () => {
  await app?.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

test('Enter into Focus and back keeps the keyboard on its place', async () => {
  await setWidthAndLocale(268, 'en')
  const focusButton = head('api-gateway').locator('[data-focus-button]')
  await head('api-gateway').locator('> button').first().focus()
  await page.keyboard.press('Tab')
  await expect(focusButton).toBeFocused()

  await page.keyboard.press('Enter')
  await expect(page.locator('[data-focus-back]')).toBeFocused()

  await page.keyboard.press('Enter')
  await expect(page.locator('[data-focus-back]')).toHaveCount(0)
  await expect(focusButton).toBeFocused()
  await expect(focusButton).toHaveCSS('opacity', '1')
})

test('at the default width the back row reads in one line', async () => {
  await setWidthAndLocale(268, 'en')
  await ensureFocused()

  const [label, others, needs, failed] = await phrases([
    'All folders',
    '4 others',
    '2 need you',
    '2 failed'
  ])
  for (const phrase of [label, others, needs, failed]) expect(phrase?.whole).toBe(true)
  expect(Math.abs(needs!.line - label!.line)).toBeLessThanOrEqual(2)
})

for (const [locale, texts] of [
  ['en', ['All folders', '2 need you', '2 failed']],
  ['pt-BR', ['Todas as pastas', '2 precisam de você', '2 falharam']]
] as const) {
  test(`at the minimum width both operator counts stay whole (${locale})`, async () => {
    await setWidthAndLocale(268, 'en')
    await ensureFocused()
    await setWidthAndLocale(200, locale)

    const drawn = await phrases([...texts])
    expect(drawn.map((phrase) => [phrase?.text, phrase?.whole])).toEqual(
      texts.map((text) => [text, true])
    )
    const row = await page.locator('[data-focus-back]').boundingBox()
    expect(row!.height).toBe(35)
    expect(
      await page.locator('.sidebar-tree-scroll').evaluate((el) => el.scrollWidth - el.clientWidth)
    ).toBe(0)
  })
}
