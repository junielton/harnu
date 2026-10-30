// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SchedulerView from '../src/renderer/src/components/SchedulerView.vue'
import { useSchedulerStore } from '../src/renderer/src/stores/scheduler'
import { i18n } from '@renderer/i18n'
import { stubTakeoverShellTargets } from './helpers/takeover-shell-stub'
import type { Run, Worker } from '../src/preload'

/**
 * T590 — the Scheduler takeover's folder-grouped worker list (approved mockup
 * `pastas--combinada`), driven through the real `SchedulerView`: folder groups and their
 * headers, collapse (per folder + all, persisted), the search field and state chips, the
 * Up next strip, and the row's pin slot, run ticks and hover actions (revision 2 — no cycle bar, no selection rail).
 */

const FOLDERS_KEY = 'om2tab.scheduler.collapsedFolders'
const UPNEXT_KEY = 'om2tab.scheduler.upNextCollapsed'
const MIN = 60_000

function worker(id: string, folder: string, over: Partial<Worker> = {}): Worker {
  return {
    id,
    name: `worker-${id}`,
    enabled: true,
    prompt: `prompt for ${id}`,
    folder,
    everyMinutes: 30,
    runOnBoot: false,
    model: 'haiku',
    effort: 'low',
    mode: 'observe',
    timeoutSeconds: 300,
    carryLastResult: false,
    failureStreak: 0,
    ...over
  }
}

function run(workerId: string, status: Run['status'], agoMin: number): Run {
  const startedAt = Date.now() - agoMin * MIN
  return {
    workerId,
    startedAt,
    endedAt: startedAt + 1000,
    durationMs: 1000,
    status,
    result: 'SECRET-LAST-RESULT',
    terminalReason: '',
    numTurns: 1,
    costUsd: 0,
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    denials: []
  }
}

let state: Worker[]
let runsById: Record<string, Run[]>

function stubApi(): void {
  const api = {
    schedulerList: vi.fn(async () => state),
    schedulerSetPinned: vi.fn(async () => state),
    schedulerSave: vi.fn(async () => state),
    schedulerRuns: vi.fn(async (id: string) => runsById[id] ?? []),
    bundledSkillsGet: vi.fn(async () => ({})),
    bundledSkillsGetFolder: vi.fn(async () => ({})),
    claudeConfigGetGlobal: vi.fn(async () => ({})),
    claudeConfigListEndpoints: vi.fn(async () => [])
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get(t: Record<string, unknown>, k: string) {
      return k in t ? t[k] : () => () => {}
    }
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flushPromises()
}

async function mountView(runningIds: string[] = []): Promise<ReturnType<typeof mount>> {
  stubTakeoverShellTargets()
  const wrapper = mount(SchedulerView, { global: { plugins: [i18n] }, attachTo: document.body })
  await settle()
  if (runningIds.length) {
    useSchedulerStore().runningIds = runningIds
    await settle()
  }
  return wrapper
}

type W = ReturnType<typeof mount>
const groupNames = (w: W): string[] => w.findAll('[data-folder-name]').map((n) => n.text())
const groupEl = (w: W, name: string): ReturnType<W['find']> =>
  w
    .findAll('[data-folder-group]')
    .find((g) => g.get('[data-folder-name]').text() === name) as ReturnType<W['find']>
const rowNames = (w: W): string[] =>
  w.findAll('[role="option"] [data-worker-name]').map((n) => n.text())
const rowFor = (w: W, name: string): ReturnType<W['find']> =>
  w.findAll('[role="option"]').find((r) => r.text().includes(name)) as ReturnType<W['find']>

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  // alpha: one waiting, one failing · beta: one running · gamma: one off · delta: one waiting
  state = [
    worker('a1', '/org/alpha', { name: 'worker-a1', prompt: 'review the pull requests' }),
    worker('a2', '/org/alpha', { name: 'worker-a2', mode: 'act', failureStreak: 1 }),
    worker('b1', '/org/beta', { name: 'worker-b1' }),
    worker('g1', '/org/gamma', { name: 'worker-g1', enabled: false }),
    worker('d1', '/org/delta', { name: 'worker-d1' })
  ]
  runsById = {
    a1: [run('a1', 'ok', 40), run('a1', 'error', 20), run('a1', 'ok', 15)],
    a2: [run('a2', 'ok', 30), run('a2', 'error', 5)],
    b1: [run('b1', 'ok', 10)],
    d1: [run('d1', 'ok', 29)]
  }
  stubApi()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('folder groups (AC-1)', () => {
  it('groups by folder in a fixed alphabetical order, whatever is running or failing', async () => {
    const w = await mountView(['b1'])
    expect(groupNames(w)).toEqual(['alpha', 'beta', 'delta', 'gamma'])
    w.unmount()
  })

  it('draws the 44px header: initial, name, count, line 2, pills and the health bar', async () => {
    const w = await mountView(['b1'])
    const alpha = groupEl(w, 'alpha')
    const head = alpha.get('[data-folder-header]')
    expect(head.classes()).toContain('h-11')
    expect(head.get('[data-folder-avatar]').text()).toBe('A')
    expect(head.get('[data-folder-count]').text()).toBe('2')
    expect(head.get('[data-folder-line2]').text()).toContain('2 on')
    expect(head.get('[data-folder-line2]').text()).toContain('next in')
    expect(head.get('[data-pill="failing"]').text()).toBe('1 failing')
    expect(head.find('[data-pill="running"]').exists()).toBe(false)
    expect(head.find('[data-health-bar]').exists()).toBe(true)
    expect(head.attributes('title')).toBe('/org/alpha')

    const beta = groupEl(w, 'beta').get('[data-folder-header]')
    expect(beta.get('[data-pill="running"]').text()).toBe('1 running')
    expect(beta.get('[data-folder-line2]').text()).toContain('running now')

    const gamma = groupEl(w, 'gamma').get('[data-folder-header]')
    expect(gamma.get('[data-folder-line2]').text()).toContain('0 on')
    expect(gamma.get('[data-folder-line2]').text()).toContain('1 off')
    expect(gamma.get('[data-folder-line2]').text()).toContain('nothing scheduled')
    w.unmount()
  })

  it('wears one stable hue class per folder on the group root', async () => {
    const w = await mountView()
    for (const g of w.findAll('[data-folder-group]')) {
      expect(g.classes().some((c) => c.startsWith('fh-'))).toBe(true)
    }
    const first = groupEl(w, 'alpha')
      .classes()
      .find((c) => c.startsWith('fh-'))
    w.unmount()
    const again = await mountView()
    expect(groupEl(again, 'alpha').classes()).toContain(first)
    again.unmount()
  })

  it('default selection is the first row of the first folder', async () => {
    const w = await mountView()
    expect(useSchedulerStore().selectedId).toBe('a1')
    w.unmount()
  })
})

describe('group separator (AC-12)', () => {
  // jsdom resolves no Tailwind, so the 1px line is asserted through its token classes.
  const groups = (w: W): ReturnType<W['find']>[] => w.findAll('[data-folder-group]')
  const separated = (g: ReturnType<W['find']>): boolean =>
    g.classes().includes('border-b') && g.classes().includes('border-border')

  async function expectSeparators(w: W): Promise<void> {
    const all = groups(w)
    expect(all.length).toBeGreaterThanOrEqual(3)
    // every group draws a 1px token line under itself ...
    for (const g of all) expect(separated(g)).toBe(true)
    // ... except the last one, which must leave no stray line under the list
    // (`last:border-b-0` rides on every group; `:last-child` picks the one that ends the list)
    for (const g of all) expect(g.classes()).toContain('last:border-b-0')
    // `last:` only works when the groups are the list's own children and the last one ends it
    const list = w.get('[role="listbox"]').element
    for (const g of all) expect(g.element.parentElement).toBe(list)
    expect(list.lastElementChild).toBe(all[all.length - 1].element)
  }

  it('separates consecutive collapsed groups by 1px, with no extra line after the last', async () => {
    localStorage.setItem(
      FOLDERS_KEY,
      JSON.stringify(['/org/alpha', '/org/beta', '/org/delta', '/org/gamma'])
    )
    const w = await mountView()
    await expectSeparators(w)
    // a collapsed header must not add its own line on top of the group's (that would be 2px)
    for (const g of groups(w)) {
      expect(g.get('[data-folder-header]').classes()).not.toContain('border-b')
    }
    w.unmount()
  })

  it('separates consecutive expanded groups by 1px, with no extra line after the last', async () => {
    const w = await mountView()
    await expectSeparators(w)
    // expanded, the header keeps its own line above the rows
    for (const g of groups(w)) {
      expect(g.get('[data-folder-header]').classes()).toContain('border-b')
    }
    w.unmount()
  })

  it('keeps the separators when collapsed and expanded groups are mixed', async () => {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(['/org/beta']))
    const w = await mountView()
    await expectSeparators(w)
    w.unmount()
  })
})

describe('collapse (AC-2)', () => {
  it('a folder collapses from its header, persists, and never changes the selection', async () => {
    const w = await mountView()
    const store = useSchedulerStore()
    await rowFor(w, 'worker-a2').trigger('click')
    expect(store.selectedId).toBe('a2')

    await groupEl(w, 'alpha').get('[data-folder-header]').trigger('click')
    expect(rowNames(w)).not.toContain('worker-a2')
    expect(groupEl(w, 'alpha').get('[data-folder-header]').attributes('aria-expanded')).toBe(
      'false'
    )
    expect(store.selectedId).toBe('a2')
    expect(JSON.parse(localStorage.getItem(FOLDERS_KEY)!)).toEqual(['/org/alpha'])

    await groupEl(w, 'alpha').get('[data-folder-header]').trigger('click')
    expect(rowNames(w)).toContain('worker-a2')
    expect(JSON.parse(localStorage.getItem(FOLDERS_KEY)!)).toEqual([])
    w.unmount()
  })

  it('restores collapsed folders from storage and defaults to expanded', async () => {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(['/org/alpha']))
    const w = await mountView()
    expect(rowNames(w)).not.toContain('worker-a1')
    expect(rowNames(w)).toContain('worker-b1')
    w.unmount()

    localStorage.clear()
    const again = await mountView()
    expect(rowNames(again)).toContain('worker-a1')
    again.unmount()
  })

  it('Collapse all / Expand all sits right of the search and flips with the state', async () => {
    const w = await mountView()
    const btn = (): ReturnType<W['get']> => w.get('[data-toggle-all]')
    expect(btn().attributes('data-mode')).toBe('collapse')
    expect(btn().attributes('aria-label')).toBe('Collapse all')

    await btn().trigger('click')
    expect(rowNames(w)).toEqual([])
    expect(w.findAll('[data-folder-group]')).toHaveLength(4)
    expect(btn().attributes('data-mode')).toBe('expand')
    expect(btn().attributes('aria-label')).toBe('Expand all')
    expect(JSON.parse(localStorage.getItem(FOLDERS_KEY)!).sort()).toEqual([
      '/org/alpha',
      '/org/beta',
      '/org/delta',
      '/org/gamma'
    ])

    await btn().trigger('click')
    expect(rowNames(w)).toHaveLength(5)
    expect(JSON.parse(localStorage.getItem(FOLDERS_KEY)!)).toEqual([])
    w.unmount()
  })

  it('collapsing everything keeps the detail on the selected worker', async () => {
    const w = await mountView()
    await w.get('[data-toggle-all]').trigger('click')
    expect(useSchedulerStore().selectedId).toBe('a1')
    expect(w.text()).toContain('worker-a1')
    w.unmount()
  })

  it('still renders and collapses when localStorage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const w = await mountView()
    expect(rowNames(w)).toHaveLength(5)
    await groupEl(w, 'alpha').get('[data-folder-header]').trigger('click')
    expect(rowNames(w)).not.toContain('worker-a1')
    w.unmount()
  })
})

describe('search and state chips (AC-3)', () => {
  it('chips show live counts (there is no All chip); Failing is failed + disabled', async () => {
    state.push(worker('x1', '/org/delta', { enabled: false, failureStreak: 3 }))
    const w = await mountView(['b1'])
    const count = (c: string): string => w.get(`[data-chip="${c}"] b`).text()
    expect(count('running')).toBe('1')
    expect(count('failing')).toBe('2') // a2 failed + x1 auto-disabled
    expect(count('waiting')).toBe('2') // a1, d1
    expect(count('off')).toBe('1') // g1
    expect(w.find('[data-chip="all"]').exists()).toBe(false)
    expect(w.findAll('[data-chip]').map((c) => c.attributes('data-chip'))).toEqual([
      'running',
      'failing',
      'waiting',
      'off'
    ])
    w.unmount()
  })

  it('the Failing chip narrows rows and hides groups with nothing to show; clicking it again clears', async () => {
    const w = await mountView()
    await w.get('[data-chip="failing"]').trigger('click')
    expect(w.get('[data-chip="failing"]').attributes('aria-pressed')).toBe('true')
    expect(rowNames(w)).toEqual(['worker-a2'])
    expect(groupNames(w)).toEqual(['alpha'])

    await w.get('[data-chip="failing"]').trigger('click')
    expect(w.get('[data-chip="failing"]').attributes('aria-pressed')).toBe('false')
    expect(rowNames(w)).toHaveLength(5)
    expect(groupNames(w)).toHaveLength(4)
    w.unmount()
  })

  it('the search matches worker name, folder and prompt', async () => {
    const w = await mountView()
    const search = w.get('[data-list-search]')

    await search.setValue('worker-d1')
    expect(rowNames(w)).toEqual(['worker-d1'])

    await search.setValue('GAMMA')
    expect(rowNames(w)).toEqual(['worker-g1'])

    await search.setValue('pull requests')
    expect(rowNames(w)).toEqual(['worker-a1'])
    w.unmount()
  })

  it('shows the empty state for no match, and Clear filter resets search and chip', async () => {
    const w = await mountView()
    await w.get('[data-chip="off"]').trigger('click')
    await w.get('[data-list-search]').setValue('deploy')

    const empty = w.get('[data-list-empty]')
    expect(empty.text()).toContain('No worker matches “deploy”')
    expect(w.findAll('[data-folder-group]')).toHaveLength(0)

    await w.get('[data-clear-filter]').trigger('click')
    expect((w.get('[data-list-search]').element as HTMLInputElement).value).toBe('')
    expect(w.findAll('[data-chip][aria-pressed="true"]')).toHaveLength(0)
    expect(rowNames(w)).toHaveLength(5)
    expect(w.find('[data-list-empty]').exists()).toBe(false)
    w.unmount()
  })
})

describe('Up next (AC-4)', () => {
  it('lists the next four due runs across folders, running first', async () => {
    const w = await mountView(['b1'])
    const rows = w.findAll('[data-up-next-row]')
    expect(rows).toHaveLength(4)
    expect(rows[0].text()).toContain('now')
    expect(rows[0].text()).toContain('worker-b1')
    expect(rows[0].text()).toContain('beta')
    // g1 is off, so it is never due
    expect(w.get('[data-up-next]').text()).not.toContain('worker-g1')
    w.unmount()
  })

  it('collapses from its header to a one-line summary of the next run, and persists', async () => {
    const w = await mountView(['b1'])
    await w.get('[data-up-next-toggle]').trigger('click')
    expect(w.find('[data-up-next-rows]').exists()).toBe(false)
    expect(w.get('[data-up-next-summary]').text()).toBe('now · worker-b1 · beta')
    expect(localStorage.getItem(UPNEXT_KEY)).toBe('1')
    w.unmount()

    const again = await mountView(['b1'])
    expect(again.find('[data-up-next-rows]').exists()).toBe(false)
    await again.get('[data-up-next-toggle]').trigger('click')
    expect(again.findAll('[data-up-next-row]')).toHaveLength(4)
    expect(localStorage.getItem(UPNEXT_KEY)).toBe('0')
    again.unmount()
  })

  it('steps aside while a search or chip is active', async () => {
    const w = await mountView()
    expect(w.find('[data-up-next]').exists()).toBe(true)
    await w.get('[data-chip="failing"]').trigger('click')
    expect(w.find('[data-up-next]').exists()).toBe(false)
    w.unmount()
  })
})

describe('worker row (AC-5)', () => {
  it('is 46px with name, `every · model · mode` and no last-result line', async () => {
    const w = await mountView()
    const row = rowFor(w, 'worker-a1')
    expect(row.classes()).toContain('h-[46px]')
    expect(row.text()).toContain('every 30m')
    expect(row.text()).toContain('haiku')
    expect(row.text()).toContain('observe')
    expect(w.get('[data-worker-list]').text()).not.toContain('SECRET-LAST-RESULT')
    w.unmount()
  })

  it('shows `act` in the warning ink, and observe in the plain meta ink', async () => {
    const w = await mountView()
    expect(rowFor(w, 'worker-a2').get('[data-worker-mode]').classes()).toContain('text-warning')
    expect(rowFor(w, 'worker-a1').get('[data-worker-mode]').classes()).not.toContain('text-warning')
    w.unmount()
  })

  it('draws the last 10 runs of EVERY worker, not only the selected one', async () => {
    const w = await mountView()
    const kinds = (name: string): string[] =>
      rowFor(w, name)
        .findAll('[data-tick]')
        .map((t) => t.attributes('data-tick')!)
    // a1 is selected; a2 and d1 are not — all three have their ticks.
    expect(kinds('worker-a1')).toEqual([...Array(7).fill('none'), 'ok', 'error', 'ok'])
    expect(kinds('worker-a2')).toEqual([...Array(8).fill('none'), 'ok', 'error'])
    expect(kinds('worker-d1')).toHaveLength(10)
    expect(kinds('worker-g1')).toEqual(Array(10).fill('none'))
    w.unmount()
  })

  it('a running worker ends its ticks with a pulsing running tick', async () => {
    const w = await mountView(['b1'])
    const ticks = rowFor(w, 'worker-b1').findAll('[data-tick]')
    expect(ticks[9].attributes('data-tick')).toBe('running')
    expect(ticks[9].classes()).toContain('anim-tick-pulse')
    w.unmount()
  })

  it('has no cycle bar (revision 2)', async () => {
    const w = await mountView(['b1'])
    expect(w.find('[data-cycle-bar]').exists()).toBe(false)
    w.unmount()
  })

  it('selection is the surface wash only — no accent rail, no border (revision 2)', async () => {
    const w = await mountView()
    const selected = rowFor(w, 'worker-a1')
    expect(selected.attributes('aria-selected')).toBe('true')
    expect(selected.classes()).toContain('bg-surface')
    expect(selected.find('span.bg-accent').exists()).toBe(false)
    expect(selected.find('[class*="w-[2px]"]').exists()).toBe(false)
    const other = rowFor(w, 'worker-d1')
    expect(other.attributes('aria-selected')).toBe('false')
    expect(other.classes()).not.toContain('bg-surface')
    w.unmount()
  })

  it('is two lines on one right edge: pin slot + name + state, then meta + a fixed 48px tick box', async () => {
    const w = await mountView()
    const row = rowFor(w, 'worker-a1')
    const pin = row.get('[data-action="pin"]')
    expect(pin.classes()).toEqual(expect.arrayContaining(['h-[14px]', 'w-[14px]', 'shrink-0']))
    // name truncates; state, meta and ticks never shrink
    expect(row.get('[data-worker-name]').classes()).toContain('truncate')
    expect(row.get('[data-row-state]').classes()).toContain('shrink-0')
    expect(row.get('[data-run-ticks]').classes()).toEqual(
      expect.arrayContaining(['w-12', 'shrink-0'])
    )
    // the pin slot is on the name's line, the ticks on the meta line
    const line1 = pin.element.closest('div.gap-2')!
    expect(line1.contains(row.get('[data-worker-name]').element)).toBe(true)
    expect(line1.contains(row.get('[data-row-state]').element)).toBe(true)
    expect(line1.contains(row.get('[data-run-ticks]').element)).toBe(false)
    w.unmount()
  })

  it('has ONE pin: the slot before the name, accent when pinned, disabled ink when not', async () => {
    state = state.map((x) => (x.id === 'a2' ? { ...x, pinnedAt: 5 } : x))
    const w = await mountView()
    for (const r of w.findAll('[role="option"]')) {
      expect(r.findAll('[data-action="pin"]')).toHaveLength(1)
      expect(r.find('[data-row-actions] [data-action="pin"]').exists()).toBe(false)
    }
    const pinned = rowFor(w, 'worker-a2').get('[data-action="pin"]')
    expect(pinned.attributes('aria-pressed')).toBe('true')
    expect(pinned.classes()).toContain('text-accent')
    const free = rowFor(w, 'worker-a1').get('[data-action="pin"]')
    expect(free.attributes('aria-pressed')).toBe('false')
    expect(free.classes()).toContain('text-text-disabled')
    expect(free.classes()).toContain('group-hover:text-text-4')
    w.unmount()
  })

  it("hover shows only Run now / Stop + Delete, in the state's place on line 1", async () => {
    const w = await mountView(['b1'])
    const labels = (name: string): string[] =>
      rowFor(w, name)
        .findAll('[data-row-actions] button')
        .map((b) => b.attributes('aria-label')!)
    expect(labels('worker-a1')).toEqual(['Run now', 'Delete'])
    expect(labels('worker-b1')).toEqual(['Stop', 'Delete'])
    const row = rowFor(w, 'worker-a1')
    expect(row.get('[data-row-state]').classes()).toContain('group-hover:hidden')
    expect(row.get('[data-row-actions]').classes()).toEqual(
      expect.arrayContaining(['hidden', 'group-hover:flex'])
    )
    w.unmount()
  })

  it('fixes line 1 at 20px and sizes the state swap to fit, so hover moves nothing (AC-8)', async () => {
    const w = await mountView(['b1'])
    for (const name of ['worker-a1', 'worker-b1', 'worker-g1']) {
      const row = rowFor(w, name)
      const line1 = row.get('[data-row-line1]')
      expect(line1.classes()).toContain('h-[20px]')
      // the action buttons may not be taller than the line they swap into
      for (const b of row.findAll('[data-row-actions] button')) {
        expect(b.classes()).toContain('h-[20px]')
        expect(b.classes()).not.toContain('h-[22px]')
      }
      expect(row.get('[data-row-actions]').classes()).toContain('h-[20px]')
    }
    w.unmount()
  })

  it('keeps enabled workers above off ones inside a folder, whatever their state (AC-9)', async () => {
    state = [
      worker('o1', '/org/alpha', { name: 'worker-o1', enabled: false }),
      worker('e1', '/org/alpha', { name: 'worker-e1' }),
      worker('o2', '/org/alpha', { name: 'worker-o2', enabled: false, pinnedAt: 7 }),
      worker('e2', '/org/alpha', { name: 'worker-e2' })
    ]
    const w = await mountView(['e2'])
    expect(rowNames(w)).toEqual(['worker-e1', 'worker-e2', 'worker-o2', 'worker-o1'])
    w.unmount()
  })

  it('uses uniform 12px left / 10px right padding on toolbar, chips, Up next, headers and rows', async () => {
    const w = await mountView()
    const row = rowFor(w, 'worker-a1')
    expect(row.classes()).toEqual(expect.arrayContaining(['pl-3', 'pr-2.5']))
    expect(w.get('[data-folder-header]').classes()).toEqual(
      expect.arrayContaining(['pl-3', 'pr-2.5'])
    )
    expect(w.get('[data-up-next]').classes()).toEqual(expect.arrayContaining(['pl-3', 'pr-2.5']))
    const chips = w.get('[data-chip="running"]').element.parentElement!
    expect(chips.className).toContain('pl-3')
    expect(chips.className).toContain('pr-2.5')
    expect(chips.className).not.toContain('flex-wrap')
    const toolbar = w.get('[data-list-search]').element.closest('div')!
    expect(toolbar.className).toContain('ml-3')
    expect(toolbar.className).toContain('mr-2.5')
    w.unmount()
  })

  it('the Collapse all button is 26x26, bordered and on the search field ground', async () => {
    const w = await mountView()
    const btn = w.get('[data-toggle-all]')
    expect(btn.classes()).toEqual(
      expect.arrayContaining(['h-[26px]', 'w-[26px]', 'border', 'border-border-2', 'bg-bg'])
    )
    w.unmount()
  })

  it('the Up next time column is a 28px left-aligned column', async () => {
    const w = await mountView(['b1'])
    const time = w.get('[data-up-next-row] span')
    expect(time.classes()).toEqual(expect.arrayContaining(['w-7', 'text-left']))
    expect(time.classes()).not.toContain('text-right')
    w.unmount()
  })
})

describe('search field focus (AC-11)', () => {
  it('opts the input out of the global focus ring so only the wrapping label shows focus', async () => {
    const w = await mountView()
    const input = w.get('[data-list-search]')
    expect(input.classes()).toContain('no-default-ring')
    expect(input.element.closest('label')!.className).toContain('focus-within:border-accent-line')
    w.unmount()
  })

  it('leaves the Collapse all button on the global keyboard ring', async () => {
    const w = await mountView()
    expect(w.get('[data-toggle-all]').classes()).not.toContain('no-default-ring')
    w.unmount()
  })
})
