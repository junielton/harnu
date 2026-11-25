import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './fixtures/launch-app'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Sidebar redesign S-5 — the "All folders" back row of Focus (design.md §6 "Sidebar
 * tree → Focus"). One line at every width: whole parts drop as it narrows, nothing is
 * ever cut, and the counts that need the operator never go. The keyboard keeps its
 * place going in and out. jsdom has no box model and no native key activation, so both
 * are driven in the built app. Requires `npm run build` first.
 */

/** The focused folder and fifteen others, enough for the widest counts. */
const NAMES = ['api-gateway', ...Array.from({ length: 15 }, (_, i) => `service-${i + 1}`)]

const id = (index: number): string =>
  `aaaaaa${String(index).padStart(2, '0')}-0000-4000-8000-000000000001`

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
  const projects = NAMES.map((name, index) => {
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

/** The first `needs` other folders wait on the operator, the next `failed` have failed. */
async function setCounts(needs: number, failed: number): Promise<void> {
  await page.evaluate(
    ([ids, needs, failed]) => {
      const vue = (document.querySelector('#app') as unknown as { __vue_app__: VueApp }).__vue_app__
      const sessions = vue.config.globalProperties.$pinia._s.get('sessions')!
      ;(ids as string[]).forEach((sessionId, i) => {
        const state =
          i < (needs as number)
            ? 'needs-input'
            : i < (needs as number) + (failed as number)
              ? 'failed'
              : undefined
        sessions.findSessionById(sessionId)!.taskState = state
      })
    },
    [NAMES.slice(1).map((_, i) => id(i + 1)), needs, failed] as const
  )
  await page.waitForTimeout(300)
}

/** What the back row draws, and how. */
const drawn = (): Promise<{
  level: string | null
  text: string
  cut: string[]
  ellipsis: string[]
  lines: number
  height: number
  title: string | null
  label: string | null
  colors: Record<string, string>
}> =>
  page.locator('[data-focus-back]').evaluate((row) => {
    const box = row.getBoundingClientRect()
    const texts: string[] = []
    const cut: string[] = []
    const tops: number[] = []
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement!
      if (!node.textContent || getComputedStyle(parent).visibility !== 'visible') continue
      texts.push(node.textContent)
      if (!node.textContent.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const r = range.getBoundingClientRect()
      tops.push(r.top + r.height / 2)
      let whole = r.left >= box.left - 0.5 && r.right <= box.right - 13.5
      for (let el: Element | null = parent; el && el !== row; el = el.parentElement) {
        if (getComputedStyle(el).overflowX === 'visible') continue
        whole &&= r.right <= el.getBoundingClientRect().right + 0.5
      }
      if (!whole) cut.push(node.textContent)
    }
    const color = (selector: string): string => {
      const el = row.querySelector(selector)
      return el ? getComputedStyle(el).color : ''
    }
    const token = (name: string): string => {
      const probe = document.createElement('span')
      probe.style.color = `var(${name})`
      document.body.appendChild(probe)
      const value = getComputedStyle(probe).color
      probe.remove()
      return value
    }
    return {
      level: row.getAttribute('data-focus-back-level'),
      text: texts.join('').replace(/\s+/g, ' ').trim(),
      cut,
      ellipsis: [row, ...row.querySelectorAll('*')]
        .filter((el) => getComputedStyle(el).textOverflow === 'ellipsis')
        .map((el) => el.textContent ?? ''),
      // Text centres more than half a line apart are on different lines.
      lines: tops.filter((top, i) => tops.findIndex((t) => Math.abs(t - top) < 6) === i).length,
      height: box.height,
      title: row.getAttribute('title'),
      label: row.getAttribute('aria-label'),
      colors: {
        label: color('[data-focus-back-label]'),
        others: color('[data-focus-back-others]'),
        needs: color('[data-focus-back-needs]'),
        failed: color('[data-focus-back-failed]'),
        text3: token('--color-text-3'),
        warning: token('--color-warning'),
        red: token('--color-red')
      }
    }
  })

/** design.md's level 2 test: the chevron and the long counts fit the row's content width. */
const longFormFits = (): Promise<boolean> =>
  page.locator('[data-focus-back]').evaluate((row) => {
    const style = getComputedStyle(row)
    const width = (part: string): number =>
      row.querySelector(`[data-focus-back-${part}]`)!.getBoundingClientRect().width
    const available =
      row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    const needed = width('chevron') + parseFloat(style.columnGap) + width('needs') + width('failed')
    return needed <= available + 0.5
  })

test.beforeAll(async () => {
  root = seed()
  app = await launchApp({ userData: root })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)
  )
  await expect(page.locator('[data-session-row]')).toHaveCount(NAMES.length, { timeout: 30_000 })
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

const CASES = [
  [
    'en',
    268,
    1,
    1,
    '1',
    'All folders1 needs you · 1 failed',
    'All folders, 15 others, 1 needs you, 1 failed'
  ],
  ['en', 200, 1, 1, '2', '1 needs you · 1 failed', 'All folders, 15 others, 1 needs you, 1 failed'],
  [
    'pt-BR',
    268,
    1,
    1,
    '1',
    'Pastas1 precisa de você · 1 falhou',
    'Pastas, 15 outras, 1 precisa de você, 1 falhou'
  ],
  // So close to the edge that the machine's sans font decides it (Inter is not bundled):
  // level 2 with the long form where that fits, else level 3 with the short one.
  [
    'pt-BR',
    200,
    1,
    1,
    'fit',
    '1 precisa de você · 1 falhou',
    'Pastas, 15 outras, 1 precisa de você, 1 falhou'
  ],
  [
    'pt-BR',
    200,
    12,
    3,
    '3',
    '12 precisam · 3 falharam',
    'Pastas, 15 outras, 12 precisam de você, 3 falharam'
  ],
  [
    'en',
    420,
    12,
    3,
    '0',
    'All folders15 others · 12 need you · 3 failed',
    'All folders, 15 others, 12 need you, 3 failed'
  ],
  ['en', 268, 0, 0, '0', 'All folders15 others', 'All folders, 15 others']
] as const

for (const [locale, width, needs, failed, level, text, full] of CASES) {
  test(`one line at ${width}px, ${needs} waiting and ${failed} failed (${locale})`, async () => {
    await setWidthAndLocale(268, 'en')
    await ensureFocused()
    await setCounts(needs, failed)
    await setWidthAndLocale(width, locale)
    // Away from the row, so its colours are the resting ones.
    await page.mouse.move(900, 700)

    let expected: { level: string; text: string } = { level, text }
    if (level === 'fit') {
      await page.evaluate(() => document.fonts.ready)
      expected = (await longFormFits())
        ? { level: '2', text }
        : { level: '3', text: '1 precisa · 1 falhou' }
    }

    await expect.poll(async () => (await drawn()).level).toBe(expected.level)
    const row = await drawn()
    expect(row.text).toBe(expected.text)
    expect(row.cut).toEqual([])
    expect(row.ellipsis).toEqual([])
    expect(row.lines).toBe(1)
    expect(row.height).toBe(35)
    expect(row.title).toBe(full)
    expect(row.label).toBe(full)
    if (needs) expect(row.colors.needs).toBe(row.colors.warning)
    if (failed) expect(row.colors.failed).toBe(row.colors.red)
    expect(row.colors.label).toBe(row.colors.text3)
    expect(row.colors.others).toBe(row.colors.text3)
    expect(
      await page.locator('.sidebar-tree-scroll').evaluate((el) => el.scrollWidth - el.clientWidth)
    ).toBe(0)
  })
}
