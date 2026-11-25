import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp } from './ci/fixtures/launch-app'

/**
 * Sidebar redesign S-2 (design.md §6 "Row states", spec AC-10 and AC-11): a row
 * says hover, selected and keyboard focus on its left bar and its text colour,
 * and nothing else moves. jsdom has no box model, so this launches the BUILT app
 * on a seeded world and measures real boxes in Chromium.
 *
 * Self-contained and subscription-free (a stub `claude` that only sleeps), so it
 * needs `npm run build` and nothing else:
 *
 *   xvfb-run -a npx playwright test --project=smoke tests/e2e/sidebar-row-states.spec.ts
 *
 * Neutral vocabulary only.
 */

const SESSION_IDS = {
  main: '00000000-0000-4000-8000-0000000000a1',
  mainTwo: '00000000-0000-4000-8000-0000000000a2',
  feat: '00000000-0000-4000-8000-0000000000a3',
  plain: '00000000-0000-4000-8000-0000000000a4'
}

interface World {
  root: string
  home: string
  bin: string
}

function seedWorld(): World {
  const root = mkdtempSync(join(tmpdir(), 'harnu-row-states-'))
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const org = join(root, 'Workspace', 'org')
  const repo = join(org, 'api-gateway')
  const feat = join(org, 'wt', 'PROJ-231-rate-limit')
  const idle = join(org, 'wt', 'PROJ-232-redis-pool')
  const plain = join(org, 'example-web')
  for (const dir of [home, bin, repo, join(org, 'wt'), plain]) mkdirSync(dir, { recursive: true })

  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: repo,
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'Seed Author',
        GIT_AUTHOR_EMAIL: 'seed@example.invalid',
        GIT_COMMITTER_NAME: 'Seed Author',
        GIT_COMMITTER_EMAIL: 'seed@example.invalid'
      }
    })
  }
  git('init', '--initial-branch=main')
  writeFileSync(join(repo, 'README.md'), '# api-gateway\n')
  git('add', '.')
  git('commit', '-m', 'chore: initial commit')
  git('worktree', 'add', '-b', 'PROJ-231-rate-limit', feat)
  git('worktree', 'add', '-b', 'PROJ-232-redis-pool', idle)

  const addedAt = new Date().toISOString()
  writeFileSync(
    join(home, 'projects.json'),
    JSON.stringify({
      version: 1,
      projects: [
        { path: repo, alias: 'api-gateway', addedAt, worktrees: [] },
        { path: plain, alias: 'example-web', addedAt, worktrees: [] }
      ],
      hiddenPaths: []
    })
  )

  const transcript = (cwd: string, id: string, title: string, branch: string): void => {
    const dir = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    const base = { sessionId: id, cwd, gitBranch: branch, entrypoint: 'cli', timestamp: addedAt }
    const lines = [
      { ...base, type: 'user', message: { role: 'user', content: title } },
      {
        ...base,
        type: 'assistant',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Done.' }]
        }
      }
    ]
    writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }
  transcript(repo, SESSION_IDS.main, 'Migrate the rate limiter to Redis', 'main')
  transcript(repo, SESSION_IDS.mainTwo, 'Pagination cursor bug', 'main')
  transcript(feat, SESSION_IDS.feat, 'Rate limit middleware', 'PROJ-231-rate-limit')
  transcript(plain, SESSION_IDS.plain, 'Hero section copy', '')

  // One running subagent under the first session: its chip and its row are in the tree.
  const subagents = join(
    home,
    '.claude',
    'projects',
    repo.replace(/[^a-zA-Z0-9]/g, '-'),
    SESSION_IDS.main,
    'subagents'
  )
  mkdirSync(subagents, { recursive: true })
  writeFileSync(
    join(subagents, 'agent-a1.jsonl'),
    JSON.stringify({
      agentId: 'a1',
      sessionId: SESSION_IDS.main,
      cwd: repo,
      type: 'user',
      timestamp: addedAt,
      message: { role: 'user', content: 'Check the limiter' }
    }) + '\n'
  )
  writeFileSync(
    join(subagents, 'agent-a1.meta.json'),
    JSON.stringify({ agentType: 'Explore', description: 'Check the limiter' })
  )

  // A stand-in `claude`: a selected row resumes it, and it must never reach a real one.
  const shim = (name: string, body: string): void => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  shim('claude', 'if [ -t 0 ]; then exec sleep 600; fi\nexit 0')
  shim('docker', 'exit 1')

  return { root, home, bin }
}

let world: World
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  world = seedWorld()
  app = await launchApp({
    userData: world.home,
    env: { PATH: `${world.bin}:${process.env.PATH ?? ''}`, SHELL: '/bin/sh' }
  })
  page = await app.firstWindow()
  await expect(page.locator('body')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900)
  })
  // No pulsing dot or sliding disclosure in a measurement.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator(`aside [data-session-id="${SESSION_IDS.feat}"]`)).toBeVisible({
    timeout: 20_000
  })
  await page.locator('aside [data-idle-row]').click()
  await expect(page.locator('aside [data-idle-worktree]')).toBeVisible()
  // Standalone folders start closed (their rows are in the DOM, clipped and inert).
  const plain = page.locator('aside [data-tree-folder]').filter({ hasText: 'example-web' })
  const chevron = plain.locator('[data-folder-chevron]')
  if ((await chevron.getAttribute('aria-expanded')) === 'false') {
    await chevron.click({ force: true })
    await expect(chevron).toHaveAttribute('aria-expanded', 'true')
  }
})

test.afterAll(async () => {
  await app?.close()
  if (world) rmSync(world.root, { recursive: true, force: true })
})

/** The rows under test, one or more of every type the seeded tree draws. */
function targets(): Record<string, Locator> {
  const tree = page.locator('aside [data-tree-folder]')
  const repo = tree.filter({ hasText: 'api-gateway' })
  return {
    'folder header (repo)': repo.locator('[data-folder-head]'),
    'folder header (non-git)': tree
      .filter({ hasText: 'example-web' })
      .locator('[data-folder-head]'),
    'checkout row (main)': repo.locator('[data-checkout-row]').first(),
    'checkout row (worktree)': repo.locator('[data-checkout-row]').nth(1),
    'idle row': repo.locator('[data-idle-row]'),
    'idle worktree': repo.locator('[data-idle-worktree]'),
    'session row': page.locator(`aside [data-session-id="${SESSION_IDS.main}"]`),
    'second session row': page.locator(`aside [data-session-id="${SESSION_IDS.mainTwo}"]`),
    'non-git session row': page.locator(`aside [data-session-id="${SESSION_IDS.plain}"]`)
  }
}

/**
 * Every box that could move: for each row in the sidebar, its own rect, padding
 * and weights, plus the rect and weight of its items two levels down. Keyed by
 * the row id so a re-render cannot pair the wrong rows.
 */
async function measure(): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const box = (el: Element): number[] => {
      const r = el.getBoundingClientRect()
      return [r.x, r.y, r.width, r.height]
    }
    const style = (el: Element): string => {
      const s = getComputedStyle(el)
      return [s.fontWeight, s.fontSize, s.padding, s.margin, s.borderWidth].join('|')
    }
    const out: Record<string, unknown> = {}
    for (const row of document.querySelectorAll('aside [data-sidebar-row]')) {
      const items = [...row.querySelectorAll(':scope > *, :scope > * > *')].filter(
        // The session dot is repainted as the process comes up; its 12px slot is what is measured.
        (el) => !el.closest('[data-session-row] > span:first-child > *')
      )
      out[row.getAttribute('data-sidebar-row')!] = {
        row: [box(row), style(row)],
        items: items.map((el) => [el.tagName, box(el), style(el)])
      }
    }
    return out
  })
}

/** Focus a row the way Tab would: a key press first, so `:focus-visible` matches. */
async function keyboardFocus(row: Locator): Promise<void> {
  await page.keyboard.press('Shift')
  const inner = row.locator(':scope > button').first()
  const target = (await row.evaluate((el) => el.tagName)) === 'BUTTON' ? row : inner
  await target.evaluate((el) => (el as HTMLElement).focus({ focusVisible: true } as FocusOptions))
  expect(await target.evaluate((el) => el.matches(':focus-visible'))).toBe(true)
}

async function blur(): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(900, 500)
}

/** Arrow down (from wherever the cursor is) until `row` holds it. */
async function moveCursorTo(row: Locator): Promise<void> {
  await blur()
  for (const key of ['ArrowUp', 'ArrowDown']) {
    for (let step = 0; step < 24; step++) {
      if ((await row.getAttribute('data-focused')) === 'true') return
      await page.keyboard.press(key)
    }
  }
  throw new Error('the arrow cursor never reached the row')
}

/** What the row paints: its bar, its own fill and outline, and its label colour. */
async function paint(row: Locator): Promise<Record<string, string>> {
  // The bar's colour transitions over --dur-fast; read it once it has landed.
  await page.waitForTimeout(200)
  return row.evaluate((el) => {
    const probe = (token: string): string => {
      const span = document.createElement('span')
      span.style.color = `var(${token})`
      document.body.append(span)
      const color = getComputedStyle(span).color
      span.remove()
      return color
    }
    const name = (color: string): string =>
      ['--color-text', '--color-text-2', '--color-accent', '--color-border-2'].find(
        (token) => probe(token) === color
      ) ?? color
    const bar = getComputedStyle(el, '::before')
    const own = getComputedStyle(el)
    const button = el.tagName === 'BUTTON' ? el : (el.querySelector(':scope > button') ?? el)
    const painted = bar.content !== 'none' && bar.backgroundColor !== 'rgba(0, 0, 0, 0)'
    return {
      bar: painted ? `${bar.width} ${name(bar.backgroundColor)} x=${bar.left}` : 'none',
      outline: [getComputedStyle(button).outlineStyle, own.outlineStyle].join(' '),
      background: own.backgroundImage === 'none' ? own.backgroundColor : own.backgroundImage,
      label: name(getComputedStyle(button).color)
    }
  })
}

// Paint runs first, while nothing is selected; the geometry test selects rows.
test('every state paints only the bar', async () => {
  const TRANSPARENT = 'rgba(0, 0, 0, 0)'
  await blur()

  for (const [name, row] of Object.entries(targets())) {
    const isSession = name.includes('session row')
    const isHeader = name.startsWith('folder header')
    // A sticky header is opaque so rows can scroll under it; that fill never changes.
    const fill = (await paint(row)).background
    if (!isHeader) expect(fill, `${name}: rest fill`).toBe(TRANSPARENT)

    await row.hover()
    const hover = await paint(row)
    expect(hover.bar, `${name}: hover bar`).toBe(
      `2px --color-text-2 x=${isSession ? '19.5px' : '0px'}`
    )
    expect(hover.background, `${name}: hover fill`).toBe(fill)
    expect(hover.label, `${name}: hover label`).toBe('--color-text')
    await blur()

    await keyboardFocus(row)
    const focus = await paint(row)
    expect(focus.bar, `${name}: focus bar`).toBe(`3px --color-text x=${isSession ? '19px' : '0px'}`)
    expect(focus.outline, `${name}: no outline box`).toBe('none none')
    expect(focus.background, `${name}: focus fill`).toBe(fill)
    expect(focus.label, `${name}: focus label`).toBe('--color-text')
    await blur()

    await moveCursorTo(row)
    const cursor = await paint(row)
    expect(cursor.bar, `${name}: cursor bar equals focus bar`).toBe(focus.bar)
    expect(cursor.outline, `${name}: cursor draws no outline`).toBe('none none')
  }
})

test('no row moves between states', async () => {
  await blur()
  const rest = await measure()
  expect(Object.keys(rest).length).toBeGreaterThanOrEqual(9)

  for (const [name, row] of Object.entries(targets())) {
    await row.hover()
    expect(await row.evaluate((el) => el.matches(':hover'))).toBe(true)
    expect(await measure(), `${name}: hover`).toEqual(rest)
    await blur()

    await keyboardFocus(row)
    expect(await measure(), `${name}: keyboard focus`).toEqual(rest)
    await blur()
    expect(await measure(), `${name}: back at rest`).toEqual(rest)
  }

  // Selected session, then focus on top of selected.
  const session = targets()['session row']
  await session.click()
  await expect(session).toHaveAttribute('data-selected', 'true')
  await blur()
  expect(await measure(), 'selected session').toEqual(rest)
  await session.hover()
  expect(await measure(), 'selected session + hover').toEqual(rest)
  await keyboardFocus(session)
  expect(await measure(), 'selected session + focus').toEqual(rest)
  await blur()

  // Current folder header, then focus on top of current.
  const header = targets()['folder header (repo)']
  await header.locator(':scope > button').click()
  await expect(header).toHaveAttribute('data-current', 'true')
  await blur()
  expect(await measure(), 'current header').toEqual(rest)
  await keyboardFocus(header)
  expect(await measure(), 'current header + focus').toEqual(rest)
  await blur()

  // The arrow cursor, on every row.
  for (const [name, row] of Object.entries(targets())) {
    await moveCursorTo(row)
    expect(await measure(), `${name}: arrow cursor`).toEqual(rest)
  }
})

const TRANSPARENT = 'rgba(0, 0, 0, 0)'

test('the selected session and the current header paint the accent bar and no fill', async () => {
  const rows: [string, Locator, () => Promise<void>, string, string][] = [
    [
      'session row',
      targets()['session row'],
      () => targets()['session row'].click({ position: { x: 60, y: 10 } }),
      'data-selected',
      '19'
    ],
    [
      'folder header',
      targets()['folder header (repo)'],
      () => targets()['folder header (repo)'].locator(':scope > button').click(),
      'data-current',
      '0'
    ]
  ]
  for (const [name, row, select, attribute, x] of rows) {
    await blur()
    const fill = (await paint(row)).background
    if (name === 'session row') expect(fill, `${name}: rest fill`).toBe(TRANSPARENT)
    await select()
    await expect(row).toHaveAttribute(attribute, 'true')
    await blur()
    const x2 = x === '19' ? '19.5px' : '0px'
    const x3 = x === '19' ? '19px' : '0px'

    for (const [state, enter] of [
      ['selected', async (): Promise<void> => {}],
      ['selected + hover', (): Promise<void> => row.hover()]
    ] as const) {
      await enter()
      const painted = await paint(row)
      expect(painted.bar, `${name}: ${state}`).toBe(`2px --color-accent x=${x2}`)
      expect(painted.background, `${name}: ${state} fill`).toBe(fill)
      expect(painted.label, `${name}: ${state} label`).toBe('--color-text')
      await blur()
    }

    await keyboardFocus(row)
    const focused = await paint(row)
    expect(focused.bar, `${name}: focus + selected`).toBe(`3px --color-accent x=${x3}`)
    expect(focused.background, `${name}: focus + selected fill`).toBe(fill)
    expect(focused.outline, `${name}: focus + selected outline`).toBe('none none')
    await blur()
  }
})

test('keyboard focus on a chip inside a row lights the row bar and draws no box', async () => {
  // Nothing selected on this row: the header holds the selection.
  await targets()['folder header (repo)'].locator(':scope > button').click()
  const row = targets()['session row']
  const chip = row.locator('[role="button"][tabindex="0"]').first()
  await blur()
  await page.keyboard.press('Shift')
  await chip.evaluate((el) => (el as HTMLElement).focus({ focusVisible: true } as FocusOptions))
  expect(await chip.evaluate((el) => el.matches(':focus-visible'))).toBe(true)

  const painted = await paint(row)
  expect(painted.bar).toBe('3px --color-text x=19px')
  expect(painted.background).toBe(TRANSPARENT)
  expect(painted.label).toBe('--color-text')
  expect(await chip.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none')
  await blur()
})

test('keyboard focus tells the header chevron apart from the header name', async () => {
  const header = targets()['folder header (repo)']
  const chevron = header.locator('[data-folder-chevron]')
  const colour = (): Promise<string> => chevron.evaluate((el) => getComputedStyle(el).color)
  // The name button always reads in --text.
  const lit = await header
    .locator(':scope > button')
    .first()
    .evaluate((el) => getComputedStyle(el).color)

  await blur()
  await keyboardFocus(header)
  expect(await colour(), 'focus on the name leaves the chevron quiet').not.toBe(lit)
  await blur()

  await page.keyboard.press('Shift')
  await chevron.evaluate((el) => (el as HTMLElement).focus({ focusVisible: true } as FocusOptions))
  expect(await chevron.evaluate((el) => el.matches(':focus-visible'))).toBe(true)
  expect(await colour(), 'the focused chevron lights up').toBe(lit)
  expect(await chevron.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none')
  expect((await paint(header)).bar.startsWith('3px ')).toBe(true)
  await blur()
})

test('the header chevron and an agent row fill nothing', async () => {
  const header = targets()['folder header (repo)']
  const chevron = header.locator('[data-folder-chevron]')
  await header.hover()
  await chevron.hover()
  await page.waitForTimeout(200)
  expect(await chevron.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(TRANSPARENT)
  await blur()

  const chip = targets()['session row'].locator('[role="button"][tabindex="0"]').first()
  if ((await chip.getAttribute('aria-expanded')) === 'false') await chip.click({ force: true })
  const agent = page.locator('aside .agent-row').first()
  await expect(agent).toBeVisible()
  await blur()
  expect((await paint(agent)).background).toBe(TRANSPARENT)
  await agent.hover()
  const hovered = await paint(agent)
  expect(hovered.bar).toBe('2px --color-text-2 x=19.5px')
  expect(hovered.background).toBe(TRANSPARENT)
  await blur()
})
