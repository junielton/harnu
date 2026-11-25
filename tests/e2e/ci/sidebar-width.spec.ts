import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './fixtures/launch-app'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Sidebar redesign S-1, AC-4 — the checkout tree never grows wider than its list.
 *
 * The folder and checkout disclosures are grids, and a grid's implicit column grows
 * to its content's min width: an agent row (label, type chip, skill, status) pushed
 * the list sideways and the value slot past its edge. jsdom has no box model, so
 * this measures real boxes in the built app. Requires `npm run build` first.
 */

const LEAD = 'aaaaaaaa-0000-4000-8000-000000000001'
const MATE = 'bbbbbbbb-0000-4000-8000-000000000002'
const OTHER = 'cccccccc-0000-4000-8000-000000000003'
const LONG =
  'Migrate the rate limiter to a shared Redis pool and keep every health check green while it rolls out'

type VueApp = {
  config: { globalProperties: { $pinia: { _s: Map<string, { sidebarWidth: number }> } } }
}

let root = ''
let app: ElectronApplication
let page: Page

const slug = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=a@example.test', '-c', 'user.name=seed', ...args], {
    cwd,
    stdio: 'ignore'
  })
}

function jsonl(path: string, lines: object[]): void {
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
}

function transcript(
  home: string,
  cwd: string,
  id: string,
  title: string,
  extra: object = {}
): void {
  const dir = join(home, '.claude', 'projects', slug(cwd))
  mkdirSync(dir, { recursive: true })
  jsonl(join(dir, `${id}.jsonl`), [
    {
      type: 'user',
      message: { role: 'user', content: title },
      cwd,
      sessionId: id,
      timestamp: new Date().toISOString(),
      uuid: `${id.slice(0, 8)}-0000-4000-8000-0000000000f1`,
      version: '2.1.0',
      ...extra
    },
    { type: 'custom-title', customTitle: title, sessionId: id }
  ])
}

/** A repo with a worktree; its main session leads a subagent and a teammate. */
function seed(): string {
  const home = mkdtempSync(join(tmpdir(), 'harnu-sidebar-width-'))
  const repo = join(home, 'Workspace', 'org', 'api-gateway')
  const worktree = join(home, 'Workspace', 'org', 'PROJ-231-rate-limit')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), '# seed\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'seed')
  git(repo, 'worktree', 'add', '-q', '-b', 'PROJ-231-rate-limit-with-a-very-long-branch', worktree)

  transcript(home, repo, LEAD, LONG)
  transcript(home, repo, MATE, 'teammate', {
    teamName: 'session-aaaaaaaa',
    agentName: `teammate-${LONG.replaceAll(' ', '-')}`
  })
  transcript(home, worktree, OTHER, LONG)

  const agents = join(home, '.claude', 'projects', slug(repo), LEAD, 'subagents')
  mkdirSync(agents, { recursive: true })
  jsonl(join(agents, 'agent-a1b2c3.jsonl'), [
    {
      type: 'user',
      isSidechain: true,
      agentId: 'a1b2c3',
      sessionId: LEAD,
      cwd: repo,
      message: { role: 'user', content: LONG },
      attributionSkill: 'superpowers:dispatching-parallel-agents',
      attributionAgent: 'general-purpose',
      timestamp: new Date().toISOString()
    }
  ])
  writeFileSync(
    join(agents, 'agent-a1b2c3.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: LONG })
  )

  // A second, finished subagent: its row sits under the "N done" fold and carries no status.
  jsonl(join(agents, 'agent-d4e5f6.jsonl'), [
    {
      type: 'user',
      isSidechain: true,
      agentId: 'd4e5f6',
      sessionId: LEAD,
      cwd: repo,
      message: { role: 'user', content: LONG },
      attributionSkill: 'superpowers:dispatching-parallel-agents',
      timestamp: '2026-01-15T12:00:00.000Z'
    }
  ])
  writeFileSync(
    join(agents, 'agent-d4e5f6.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: LONG })
  )
  const past = new Date(Date.now() - 3_600_000)
  utimesSync(join(agents, 'agent-d4e5f6.jsonl'), past, past)

  writeFileSync(
    join(home, 'projects.json'),
    JSON.stringify({
      version: 1,
      projects: [repo, worktree].map((path) => ({
        path,
        alias: path.split('/').pop(),
        addedAt: new Date().toISOString(),
        worktrees: []
      })),
      hiddenPaths: []
    })
  )
  return home
}

test.beforeAll(async () => {
  root = seed()
  app = await launchApp({ userData: root })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)
  )
})

test.afterAll(async () => {
  await app?.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

test('agent rows, teammate rows and long titles never widen the sidebar list', async () => {
  const lead = page.locator(`[data-session-row][data-session-id="${LEAD}"]`)
  await expect(lead).toBeAttached({ timeout: 30_000 })

  // Open the subagent and teammate rows under the lead (their chips are hover-only).
  const chips = lead.locator('[role="button"][aria-expanded]')
  await expect(chips).toHaveCount(2)
  for (const chip of await chips.all()) await chip.dispatchEvent('click')
  const fold = page.locator('[data-dsqa="sidebar-agents-done-fold"]')
  if ((await fold.count()) > 0) await fold.first().click()

  const list = page.locator('.sidebar-tree-scroll')
  await expect(list.locator('.agent-row:not(button)')).not.toHaveCount(0)
  await expect(list.locator('[data-teammate-row]')).toHaveCount(1)
  // Let the disclosure transitions settle before measuring.
  await page.waitForTimeout(800)

  const box = await list.evaluate((el) => {
    const right = (node: Element): number =>
      Math.round(node.getBoundingClientRect().right * 10) / 10
    const edge = el.getBoundingClientRect().left + el.clientWidth
    const rows = [...el.querySelectorAll('.sidebar-row, .agent-row')].filter(
      (row) => !row.closest('[inert]') && row.getBoundingClientRect().height > 0
    )
    const truncated = (selector: string): boolean => {
      const node = el.querySelector(selector) as HTMLElement
      return (
        node.scrollWidth > node.clientWidth && getComputedStyle(node).textOverflow === 'ellipsis'
      )
    }
    return {
      overflow: el.scrollWidth - el.clientWidth,
      rowsPastEdge: rows.filter((row) => right(row) > edge + 0.5).length,
      slotEdges: [...new Set([...el.querySelectorAll('[data-value-slot]')].map(right))],
      // Nothing inside a row spills past it either (screen-reader-only and overlay text excluded).
      spills: rows.flatMap((row) =>
        [...row.children]
          .filter((child) => getComputedStyle(child).position !== 'absolute')
          .filter((child) => right(child) > right(row) + 0.5)
          .map((child) => `${row.textContent?.trim().slice(0, 30)}: ${child.textContent?.trim()}`)
      ),
      titleTruncated: truncated('[data-session-row] span.truncate'),
      agentTruncated: truncated('.agent-row:not(button) span.truncate'),
      teammateTruncated: truncated('[data-teammate-row] span.truncate')
    }
  })

  expect(box.overflow).toBe(0)
  expect(box.rowsPastEdge).toBe(0)
  expect(box.slotEdges).toHaveLength(1)
  expect(box.spills).toEqual([])
  expect(box.titleTruncated).toBe(true)
  expect(box.agentTruncated).toBe(true)
  expect(box.teammateTruncated).toBe(true)
})

/** Every agent row on screen: part widths, and how far each item sits from the row's middle. */
function agentRows(): Promise<
  Array<{
    label: number
    type: number
    skill: number
    typeWhole: boolean
    skillWhole: boolean
    labelCut: boolean
    off: number
    baselineSpread: number
  }>
> {
  return page.locator('.sidebar-tree-scroll').evaluate((list) =>
    [...list.querySelectorAll('.agent-row:not(button)')]
      .filter((row) => row.getBoundingClientRect().height > 0)
      .map((row) => {
        const mid = row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2
        const label = row.querySelector('span.truncate:not(.font-mono)') as HTMLElement
        const [type, skill] = [...row.querySelectorAll<HTMLElement>('span.font-mono')]
        const centres: number[] = []
        const baselines: number[] = []
        for (const icon of row.querySelectorAll('svg, .rounded-full')) {
          const r = icon.getBoundingClientRect()
          centres.push(r.top + r.height / 2)
        }
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
        const texts: Node[] = []
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (n.textContent?.trim()) texts.push(n)
        }
        for (const node of texts) {
          const range = document.createRange()
          range.selectNodeContents(node)
          const r = range.getBoundingClientRect()
          centres.push(r.top + r.height / 2)
          const probe = document.createElement('span')
          probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'
          node.parentElement!.insertBefore(probe, node)
          baselines.push(probe.getBoundingClientRect().top)
          probe.remove()
        }
        const width = (el: HTMLElement): number => el.getBoundingClientRect().width
        return {
          label: width(label),
          type: width(type),
          skill: width(skill),
          typeWhole: type.scrollWidth <= type.clientWidth,
          // The skill is longer than its cap, so "whole" is the cap.
          skillWhole: Math.round(width(skill)) === 120,
          labelCut: label.scrollWidth > label.clientWidth,
          off: Math.max(...centres.map((c) => Math.abs(c - mid))),
          baselineSpread: Math.max(...baselines) - Math.min(...baselines)
        }
      })
  )
}

async function setSidebarWidth(width: number): Promise<void> {
  await page.evaluate((width) => {
    const app = (document.querySelector('#app') as unknown as { __vue_app__: VueApp }).__vue_app__
    app.config.globalProperties.$pinia._s.get('layout')!.sidebarWidth = width
  }, width)
  await page.waitForTimeout(600)
}

const overflow = (): Promise<number> =>
  page.locator('.sidebar-tree-scroll').evaluate((el) => el.scrollWidth - el.clientWidth)

test('an agent row keeps its type and skill: the title gives way first', async () => {
  // Rows were opened by the test above; open the "N done" fold if it is still closed.
  const fold = page.locator('[data-dsqa="sidebar-agents-done-fold"][aria-expanded="false"]')
  if ((await fold.count()) > 0) await fold.first().click()
  await page.waitForTimeout(800)

  const narrow = await agentRows()
  expect(narrow.length).toBe(2)
  for (const row of narrow) {
    expect(row.type).toBeGreaterThan(0)
    expect(row.skill).toBeGreaterThan(0)
    // The title keeps about six characters (48px, minus a layout-unit rounding).
    expect(row.label).toBeGreaterThanOrEqual(47.5)
    expect(row.off).toBeLessThanOrEqual(0.75)
    expect(row.baselineSpread).toBeLessThanOrEqual(0.75)
  }
  expect(await overflow()).toBe(0)

  // With room to spare the chips are whole while the long title is still the one cut.
  await setSidebarWidth(440)
  for (const row of await agentRows()) {
    expect(row.typeWhole).toBe(true)
    expect(row.skillWhole).toBe(true)
    expect(row.labelCut).toBe(true)
  }
  expect(await overflow()).toBe(0)

  // At the narrowest sidebar there is no room for the title's floor either: the row
  // still never pushes the list sideways.
  await setSidebarWidth(200)
  expect(await overflow()).toBe(0)
})
