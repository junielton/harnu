// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SystemMonitor from '../src/renderer/src/components/SystemMonitor.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { MONITOR_VIEW_KEY } from '../src/renderer/src/components/system-monitor-format'
import { i18n } from '@renderer/i18n'
import { stubTakeoverShellTargets, takeoverShellActions } from './helpers/takeover-shell-stub'
import type { HeapSample, MonitorSample, ProcSample, SessionSample } from '../src/preload'

/**
 * T591 — the System Monitor takeover (mockup f--combinada): Harnu sidebar, KPI strip,
 * sessions as cards or a table. jsdom sees markup, classes and behaviour, not layout —
 * the visual contract is pinned by the captures in the card report.
 */

const proc = (
  pid: number,
  name: string,
  rss: number | null,
  cpu: number | null = 1
): ProcSample => ({
  pid,
  name,
  cpuPct: cpu,
  rssBytes: rss
})

const live = (key: string, over: Partial<SessionSample> = {}): SessionSample => ({
  sessionKey: key,
  kind: 'claude-resume',
  state: 'live',
  cpuPct: 11.8,
  rssBytes: 940_000_000,
  procs: [proc(11, 'claude', 612_000_000, 9.4), proc(12, 'node', 184_000_000, 1.9)],
  idleMs: 0,
  parkable: true,
  reason: 'active',
  sweepRank: null,
  savedBytes: null,
  ...over
})
const parked = (key: string, saved: number | null): SessionSample => ({
  sessionKey: key,
  kind: 'claude-resume',
  state: 'parked',
  cpuPct: null,
  rssBytes: null,
  procs: [],
  idleMs: 0,
  parkable: false,
  reason: 'lru',
  sweepRank: null,
  savedBytes: saved
})

const heap = (status: HeapSample['status'], used = 100): HeapSample => ({
  atMs: 0,
  usedBytes: used,
  limitBytes: 100,
  status
})

const SESSIONS = [
  live('s-harnu'),
  live('s-web', {
    rssBytes: 380_000_000,
    cpuPct: 0.6,
    procs: [proc(21, 'claude', 330_000_000)],
    reason: 'lru',
    idleMs: 12 * 60_000,
    parkable: false
  }),
  live('s-api', {
    rssBytes: 411_000_000,
    cpuPct: 0,
    procs: [],
    reason: 'hard-idle',
    idleMs: 38 * 60_000,
    sweepRank: 1
  }),
  parked('s-ex', 290_000_000),
  parked('s-www', null)
]

const sampleOf = (status: HeapSample['status'] = 'ok', sessions = SESSIONS): MonitorSample => ({
  atMs: 1,
  heap: heap(status, status === 'warn' ? 78 : status === 'critical' ? 90 : 3),
  harnu: [proc(1, 'main', 360_000_000, 0.4), proc(2, 'renderer', 355_000_000, 2.1)],
  sessions
})

let onSample: ((s: MonitorSample) => void) | null = null
let onHeap: ((s: HeapSample) => void) | null = null
const ptyPark = vi.fn(async () => undefined)
const monitorStart = vi.fn(async () => undefined)
const monitorStop = vi.fn(async () => undefined)

function stubApi(): void {
  const api: Record<string, unknown> = {
    onMonitorSample: (cb: (s: MonitorSample) => void) => {
      onSample = cb
      return () => {}
    },
    onMonitorHeap: (cb: (s: HeapSample) => void) => {
      onHeap = cb
      return () => {}
    },
    monitorStart,
    monitorStop,
    ptyPark,
    companionPing: vi.fn(async () => ({ ok: true, roundTripMs: 4 }))
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get(t: Record<string, unknown>, k: string) {
      return k in t ? t[k] : () => () => {}
    }
  })
}

const NAMES: Record<string, { alias: string; path: string; branch: string }> = {
  's-harnu': { alias: 'harnu', path: '/w/harnu', branch: 'main' },
  's-web': { alias: 'web-api', path: '/w/web-api', branch: 'fix/auth-refresh' },
  's-api': { alias: 'api-gateway', path: '/w/api-gateway', branch: 'main' },
  's-ex': { alias: 'example-web', path: '/w/example-web', branch: 'main' },
  's-www': { alias: 'org/www', path: '/w/org/www', branch: 'release/2.4' }
}

async function mountMonitor(over: { status?: HeapSample['status'] } = {}): Promise<VueWrapper> {
  stubTakeoverShellTargets()
  const sessions = useSessionsStore()
  vi.spyOn(sessions, 'folderAliasOf').mockImplementation((k: string) => NAMES[k]?.alias ?? '')
  vi.spyOn(sessions, 'findSessionById').mockImplementation(((k: string) =>
    NAMES[k]
      ? { projectPath: NAMES[k].path, gitBranch: NAMES[k].branch }
      : null) as unknown as typeof sessions.findSessionById)
  const closeSession = vi
    .spyOn(sessions, 'closeSession')
    .mockImplementation(() => undefined as never)
  void closeSession
  const wrapper = mount(SystemMonitor, { global: { plugins: [i18n] }, attachTo: document.body })
  onSample!(sampleOf(over.status ?? 'ok'))
  onHeap!(sampleOf(over.status ?? 'ok').heap)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  ptyPark.mockClear()
  monitorStart.mockClear()
  monitorStop.mockClear()
  stubApi()
})
afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('AC-1 — layout: Harnu sidebar + right column', () => {
  it('renders the sidebar with the process rows and the totals line, and the right column', async () => {
    const w = await mountMonitor()
    const side = w.get('[data-testid="monitor-sidebar"]')
    expect(side.classes()).toContain('bg-sidebar')
    expect(side.classes()).toContain('border-r')
    expect(side.text()).toContain('Harnu')
    expect(side.text()).toContain('2 processes')
    expect(side.findAll('[data-testid="process-list"] > div')).toHaveLength(2)
    expect(side.get('[data-testid="monitor-totals"]').text()).toContain('Harnu + sessions')
    expect(w.find('[data-testid="monitor-kpis"]').exists()).toBe(true)
    expect(w.get('.grid').classes()).toEqual(
      expect.arrayContaining(['grid-cols-[320px_1fr]', '@max-[1000px]:grid-cols-1'])
    )
    w.unmount()
  })

  it('draws the heap card with tick labels at 70% and 85% that sit on opposite sides', async () => {
    const w = await mountMonitor()
    const card = w.get('[data-testid="heap-card"]')
    expect(card.text()).toContain('warn 70%')
    expect(card.text()).toContain('85% crit')
    const html = card.html()
    expect(html).toContain('left: 70%')
    expect(html).toContain('left: 85%')
    expect(html).toContain('-translate-x-full')
    w.unmount()
  })
})

describe('AC-2 — KPI strip', () => {
  it('shows total RAM, CPU with the process count, and live / parked with reclaimed RAM', async () => {
    const w = await mountMonitor()
    // Harnu 715 MB + live sessions (940 + 380 + 411) = 2446 MB
    expect(w.get('[data-testid="kpi-ram"]').text()).toBe('2.45 GB')
    expect(w.get('[data-testid="monitor-kpis"]').text()).toContain('Harnu 715 MB')
    expect(w.get('[data-testid="monitor-kpis"]').text()).toContain('Sessions 1.73 GB')
    // 0.4 + 2.1 + 11.8 + 0.6 + 0
    expect(w.get('[data-testid="kpi-cpu"]').text()).toBe('14.9%')
    // 2 Harnu + (2 + 1 + 0) children of live sessions
    expect(w.get('[data-testid="monitor-kpis"]').text()).toContain('across 5 processes')
    expect(w.get('[data-testid="kpi-sessions"]').text().replace(/\s+/g, ' ')).toBe(
      '3 live · 2 parked'
    )
    expect(w.get('[data-testid="kpi-reclaimed"]').text()).toBe('~290 MB reclaimed by parking')
    w.unmount()
  })
})

describe('AC-3 — cards view (default)', () => {
  it('defaults to cards, RAM-descending, parked last', async () => {
    const w = await mountMonitor()
    expect(w.find('[data-testid="cards-view"]').exists()).toBe(true)
    expect(w.find('[data-testid="table-view"]').exists()).toBe(false)
    const names = w.findAll('[data-testid="card-name"]').map((n) => n.text())
    expect(names.slice(0, 3)).toEqual(['harnu', 'api-gateway', 'web-api'])
    expect(names.slice(3).sort()).toEqual(['example-web', 'org/www'])
    expect(w.get('[data-testid="cards-view"]').classes()).toContain(
      'grid-cols-[repeat(auto-fill,minmax(270px,1fr))]'
    )
    w.unmount()
  })

  it('a live card: hue class + stripe, branch, RAM, CPU, sparkline, composition bar, state', async () => {
    const w = await mountMonitor()
    const card = w.findAll('[data-testid="session-card"]')[0]
    expect(card.classes().some((c) => c.startsWith('fh-'))).toBe(true)
    expect(card.html()).toContain('h-[3px]')
    expect(card.text()).toContain('main')
    expect(card.text()).toContain('940')
    expect(card.text()).toContain('MB')
    expect(card.text()).toContain('12%')
    expect(card.find('[data-testid="sparkline"]').exists()).toBe(true)
    expect(card.findAll('[data-testid="composition-bar"] > span').length).toBeGreaterThanOrEqual(3)
    expect(card.get('[data-testid="composition-legend"]').text()).toContain('own')
    expect(card.text()).toContain('live')
    w.unmount()
  })

  it('shows the reason chip + idle, and the next-to-be-swept note only on rank 1', async () => {
    const w = await mountMonitor()
    const cards = w.findAll('[data-testid="session-card"]')
    const api = cards.find((c) => c.text().includes('api-gateway'))!
    expect(api.get('[data-testid="reason-chip"]').text()).toContain('hard-idle')
    expect(api.get('[data-testid="reason-chip"]').text()).toContain('38 min')
    expect(api.find('[data-testid="next-sweep"]').exists()).toBe(true)
    const web = cards.find((c) => c.text().includes('web-api'))!
    expect(web.get('[data-testid="reason-chip"]').text()).toContain('lru')
    expect(web.find('[data-testid="next-sweep"]').exists()).toBe(false)
    w.unmount()
  })

  it('a parked card is dashed, shows −X MB reclaimed (— when unknown) and the wake hint', async () => {
    const w = await mountMonitor()
    const cards = w.findAll('[data-testid="session-card"]')
    const ex = cards.find((c) => c.text().includes('example-web'))!
    expect(ex.classes()).toContain('border-dashed')
    expect(ex.get('[data-testid="reclaimed"]').text()).toContain('−290')
    expect(ex.text()).toContain('reclaimed')
    expect(ex.text()).toContain('Select it in the sidebar to wake it')
    expect(ex.find('[data-testid="sparkline"]').exists()).toBe(false)
    const www = cards.find((c) => c.text().includes('org/www'))!
    expect(www.get('[data-testid="reclaimed"]').text()).toBe('—')
    w.unmount()
  })
})

describe('AC-4 — table view and persisted toggle', () => {
  it('Table shows the columns and persists the choice under an om2tab.* key', async () => {
    const w = await mountMonitor()
    await w.get('[data-testid="view-table"]').trigger('click')
    expect(w.find('[data-testid="cards-view"]').exists()).toBe(false)
    const table = w.get('[data-testid="table-view"]')
    for (const col of ['Name', 'RAM', 'CPU', 'Last 60s', 'State'])
      expect(table.text()).toContain(col)
    expect(localStorage.getItem(MONITOR_VIEW_KEY)).toBe('table')
    expect(w.get('[data-testid="view-table"]').attributes('aria-pressed')).toBe('true')
    w.unmount()
  })

  it('restores the persisted choice on the next mount', async () => {
    localStorage.setItem(MONITOR_VIEW_KEY, 'table')
    const w = await mountMonitor()
    expect(w.find('[data-testid="table-view"]').exists()).toBe(true)
    await w.get('[data-testid="view-cards"]').trigger('click')
    expect(localStorage.getItem(MONITOR_VIEW_KEY)).toBe('cards')
    w.unmount()
  })

  it('a parked row shows −saved in green; a live row shows RAM, a hue bar and a sparkline', async () => {
    localStorage.setItem(MONITOR_VIEW_KEY, 'table')
    const w = await mountMonitor()
    const rows = w.findAll('[data-testid="session-row"]')
    const ex = rows.find((r) => r.text().includes('example-web'))!
    expect(ex.get('[data-testid="reclaimed"]').text()).toBe('−290 MB')
    expect(ex.get('[data-testid="reclaimed"]').classes()).toContain('text-green')
    const harnu = rows.find((r) => r.text().includes('harnu'))!
    expect(harnu.text()).toContain('940 MB')
    expect(harnu.find('[data-testid="sparkline"]').exists()).toBe(true)
    w.unmount()
  })

  it('keeps every row one fixed 36px line: the State cell never wraps, the chip and mod cell truncate', async () => {
    localStorage.setItem(MONITOR_VIEW_KEY, 'table')
    const w = await mountMonitor()
    for (const row of w.findAll('[data-testid="session-row"]')) {
      expect(row.classes(), 'a session row must be a fixed height').toContain('h-9')
      expect(row.classes()).not.toContain('min-h-9')
      expect(row.html(), 'nothing in a row may wrap').not.toContain('flex-wrap')
    }
    const api = w
      .findAll('[data-testid="session-row"]')
      .find((r) => r.text().includes('api-gateway'))!
    const chip = api.get('[data-testid="reason-chip"]')
    expect(chip.classes()).toEqual(expect.arrayContaining(['min-w-0', 'truncate']))
    expect(chip.attributes('title')).toBe('hard-idle · 38 min')
    // the sweep note drops to its icon in a narrower table; the words stay for tooltip and screen readers
    const sweep = api.get('[data-testid="next-sweep"]')
    expect(sweep.attributes('title')).toBe('next to be swept')
    expect(sweep.find('span').classes()).toContain('@max-[960px]:sr-only')
    w.unmount()
  })

  it('narrow tables drop Last 60s below 960px, then the branch below 760px, and keep a 250px+ State track', async () => {
    localStorage.setItem(MONITOR_VIEW_KEY, 'table')
    const w = await mountMonitor()
    const row = w.get('[data-testid="session-row"]')
    const classes = row.classes().join(' ')
    expect(classes).toContain(
      '@max-[960px]:grid-cols-[minmax(160px,1fr)_130px_52px_minmax(280px,1.8fr)]'
    )
    expect(classes).toContain(
      '@max-[760px]:grid-cols-[minmax(130px,0.8fr)_120px_46px_minmax(250px,1.6fr)]'
    )
    expect(row.get('[data-testid="row-name"]').attributes('title')).toContain('·')
    expect(row.html()).toContain('@max-[760px]:hidden')
    expect(w.get('[data-testid="table-view"]').classes()).toContain('@container')
    w.unmount()
  })

  it('a card keeps its wrapping footer: only the table is single-line', async () => {
    const w = await mountMonitor()
    const card = w
      .findAll('[data-testid="session-card"]')
      .find((c) => c.text().includes('api-gateway'))!
    expect(card.html()).toContain('flex-wrap')
    expect(card.get('[data-testid="reason-chip"]').classes()).toContain('shrink-0')
    w.unmount()
  })
})

describe('AC-5 — expand (both views, only that session)', () => {
  it('cards: the chevron opens own memory + /proc children of that card only', async () => {
    const w = await mountMonitor()
    expect(w.findAll('[data-testid="card-children"]')).toHaveLength(0)
    await w.get('[aria-label="Expand harnu"]').trigger('click')
    const open = w.findAll('[data-testid="card-children"]')
    expect(open).toHaveLength(1)
    const text = open[0].text()
    expect(text).toContain('own memory')
    expect(text).toContain('claude')
    expect(text).toContain('612 MB')
    expect(open[0].findAll('[data-testid="child-entry"]')[0].text()).toContain('144 MB')
    await w.get('[aria-label="Collapse harnu"]').trigger('click')
    expect(w.findAll('[data-testid="card-children"]')).toHaveLength(0)
    w.unmount()
  })

  it('table: indented rows with bars, own memory first; other sessions unchanged', async () => {
    localStorage.setItem(MONITOR_VIEW_KEY, 'table')
    const w = await mountMonitor()
    await w.get('[aria-label="Expand harnu"]').trigger('click')
    const kids = w.findAll('[data-testid="child-entry"]')
    expect(kids).toHaveLength(3)
    expect(kids[0].text()).toContain('own memory')
    expect(kids[1].text()).toContain('claude')
    expect(kids[1].html()).toContain('h-[3px]')
    expect(w.findAll('[aria-label^="Collapse"]')).toHaveLength(1)
    w.unmount()
  })

  it('own memory is an em dash, never 0, when one child reading is unknown', async () => {
    const odd = live('s-harnu', {
      procs: [proc(11, 'claude', null), proc(12, 'node', 184_000_000)]
    })
    stubTakeoverShellTargets()
    const w = await mountMonitor()
    onSample!(sampleOf('ok', [odd]))
    await flushPromises()
    await w.get('[aria-label="Expand harnu"]').trigger('click')
    const own = w.findAll('[data-testid="child-entry"]')[0]
    expect(own.text()).toContain('—')
    expect(own.text()).not.toContain('0 B')
    w.unmount()
  })

  it('a parked session has no chevron', async () => {
    const w = await mountMonitor()
    expect(w.find('[aria-label="Expand example-web"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('AC-6 — actions', () => {
  it('Park now only for parkable live sessions; Close for all; slots always reserved', async () => {
    const w = await mountMonitor()
    const cards = w.findAll('[data-testid="session-card"]')
    const harnu = cards.find((c) => c.text().includes('harnu'))!
    const web = cards.find((c) => c.text().includes('web-api'))!
    const ex = cards.find((c) => c.text().includes('example-web'))!
    expect(harnu.find('[aria-label="Park now"]').exists()).toBe(true)
    expect(web.find('[aria-label="Park now"]').exists()).toBe(false)
    expect(ex.find('[aria-label="Park now"]').exists()).toBe(false)
    for (const c of [harnu, web, ex]) {
      expect(c.find('[aria-label="Close"]').exists()).toBe(true)
      // 3 slots: ping, park, close — buttons or 22px placeholders
      expect(c.get('[data-testid="session-actions"]').element.children).toHaveLength(3)
    }
    w.unmount()
  })

  it('are hidden at rest and revealed on hover and focus', async () => {
    const w = await mountMonitor()
    const cls = w.get('[data-testid="session-actions"]').classes()
    expect(cls).toEqual(
      expect.arrayContaining([
        'opacity-0',
        'group-hover:opacity-100',
        'group-focus-within:opacity-100'
      ])
    )
    w.unmount()
  })

  it('Park now parks that session; Close closes it — in both views', async () => {
    const w = await mountMonitor()
    const sessions = useSessionsStore()
    const card = w.findAll('[data-testid="session-card"]').find((c) => c.text().includes('harnu'))!
    await card.get('[aria-label="Park now"]').trigger('click')
    expect(ptyPark).toHaveBeenCalledWith('s-harnu')
    await card.get('[aria-label="Close"]').trigger('click')
    expect(sessions.closeSession).toHaveBeenCalledWith('s-harnu')

    await w.get('[data-testid="view-table"]').trigger('click')
    ptyPark.mockClear()
    const row = w.findAll('[data-testid="session-row"]').find((r) => r.text().includes('harnu'))!
    await row.get('[aria-label="Park now"]').trigger('click')
    expect(ptyPark).toHaveBeenCalledWith('s-harnu')
    w.unmount()
  })
})

describe('AC-8 — heap states', () => {
  it('ok is neutral with no alert icon', async () => {
    const w = await mountMonitor({ status: 'ok' })
    expect(w.get('[data-testid="heap-fill"]').classes()).toContain('bg-text-3')
    expect(w.find('[data-testid="heap-alert-icon"]').exists()).toBe(false)
    w.unmount()
  })

  it('warn uses --warning on the gauge, the number and the header gauge, with the alert icon', async () => {
    const w = await mountMonitor({ status: 'warn' })
    expect(w.get('[data-testid="heap-fill"]').classes()).toContain('bg-warning')
    expect(w.get('[data-testid="heap-percent"]').classes()).toContain('text-warning')
    expect(w.find('[data-testid="heap-alert-icon"]').exists()).toBe(true)
    const header = takeoverShellActions().get('[data-testid="header-heap"]')
    expect(header.html()).toContain('bg-warning')
    expect(header.find('svg').exists()).toBe(true)
    w.unmount()
  })

  it('critical uses --red', async () => {
    const w = await mountMonitor({ status: 'critical' })
    expect(w.get('[data-testid="heap-fill"]').classes()).toContain('bg-red')
    expect(w.get('[data-testid="heap-percent"]').classes()).toContain('text-red')
    expect(takeoverShellActions().get('[data-testid="header-heap"]').html()).toContain('bg-red')
    w.unmount()
  })
})

describe('sampler lifecycle is unchanged', () => {
  it('acquires on mount and releases on unmount exactly once each', async () => {
    const w = await mountMonitor()
    expect(monitorStart).toHaveBeenCalledTimes(1)
    w.unmount()
    await flushPromises()
    expect(monitorStop).toHaveBeenCalledTimes(1)
  })

  it('opens the hibernation policy from the footer link', async () => {
    const w = await mountMonitor()
    const ui = useUiStore()
    const spy = vi.spyOn(ui, 'openSettings').mockImplementation(() => undefined as never)
    await w.get('footer button').trigger('click')
    expect(spy).toHaveBeenCalledWith('hibernationPolicy')
    w.unmount()
  })
})
