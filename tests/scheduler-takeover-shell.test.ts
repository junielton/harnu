// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setActivePinia, createPinia } from 'pinia'
import SchedulerView from '../src/renderer/src/components/SchedulerView.vue'
import TakeoverHost from '../src/renderer/src/components/TakeoverHost.vue'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { i18n } from '@renderer/i18n'
import { stubTakeoverShellTargets, takeoverShellActions } from './helpers/takeover-shell-stub'
import type { Worker } from '../src/preload'

/**
 * BUG-120 — the Scheduler takeover migrated onto the shared `TakeoverShell`.
 *
 * What the operator reported was chrome doubled at BOTH ends: the view drew
 * its own 40px header under the shell's, so a second title and a second close
 * button rendered stacked; and its `footerNote` strip carried the status
 * footer's exact treatment flush on top of it, so the two read as one bar.
 * Both are fixed — the header here, the bottom strip in the same card's delta.
 *
 * The root's `h-full` is fixed alongside them, but it is NOT the cause of
 * either, and the card's original diagnosis that it "spilled over the footer"
 * was disproven by measuring: the view is the shell's only flex child, so
 * `flex-shrink: 1` absorbs the 40px surplus exactly and even the whole pre-fix
 * component lands its bottom edge on the footer's top edge. `h-full` goes
 * because it is a latent trap and disagrees with every other takeover.
 *
 * What jsdom can and cannot see is the whole shape of this file. It CANNOT see
 * layout: no box model, no flexbox, so "the takeover ends above the footer" is
 * unprovable here and is pinned in a real browser instead
 * (`tests/e2e/ci/scheduler-result-css.spec.ts`, which BUG-120 extends). It CAN see markup and
 * class strings, which is what the assertions below are limited to.
 */

const WORKERS: Worker[] = [
  {
    id: 'w1',
    name: 'PR watcher',
    enabled: true,
    prompt: 'Check for new PRs.',
    folder: '/repo/alpha',
    everyMinutes: 5,
    runOnBoot: false,
    model: 'haiku',
    effort: 'low',
    mode: 'observe',
    timeoutSeconds: 300,
    carryLastResult: false,
    failureStreak: 0
  }
]

const schedulerSave = vi.fn(async (draft: Partial<Worker>) => [
  { ...WORKERS[0], ...draft, id: 'w2', name: '' } as Worker
])

function stubApi(workers: Worker[]): void {
  const api = {
    schedulerList: vi.fn(async () => workers),
    schedulerSave,
    schedulerRuns: vi.fn(async () => []),
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

const REPO = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
const VIEW = 'src/renderer/src/components/SchedulerView.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  schedulerSave.mockClear()
  stubApi(WORKERS)
})

// ── AC-3 — the header content lands in the shell's two teleport targets ─────

describe('AC-3: the icon, the worker counter and New worker render in the shell header', () => {
  it('teleports the Clock icon into #takeover-shell-icon', async () => {
    stubTakeoverShellTargets()
    const wrapper = mount(SchedulerView, { global: { plugins: [i18n] } })
    await settle()

    const icon = document.querySelector('#takeover-shell-icon')
    expect(icon?.querySelector('svg'), 'no icon landed in the shell header').not.toBeNull()

    wrapper.unmount()
  })

  it('teleports the "{n} workers · {m} running" counter and the New worker button into #takeover-shell-actions', async () => {
    stubTakeoverShellTargets()
    const wrapper = mount(SchedulerView, { global: { plugins: [i18n] } })
    await settle()

    const actions = takeoverShellActions()
    expect(actions.text()).toContain('1 worker')
    const button = actions.find('button')
    expect(button.exists(), 'the New worker button is not in the shell header').toBe(true)
    expect(button.text()).toContain('New worker')

    // It is the SAME button, not a decorative copy: clicking it still runs
    // the view's `createWorker` handler across the Teleport boundary.
    await button.trigger('click')
    await settle()
    expect(schedulerSave, 'the teleported button no longer creates a worker').toHaveBeenCalled()

    wrapper.unmount()
  })
})

// ── AC-2 — one header, one title, one close button ─────────────────────────

describe('AC-2: the view no longer draws a header, a title or a close button of its own', () => {
  it('renders no h-10 header row and no scheduler.close button in its own subtree', async () => {
    stubTakeoverShellTargets()
    const wrapper = mount(SchedulerView, { global: { plugins: [i18n] } })
    await settle()

    // The shell owns the only close button; the view must not render a second.
    const closes = wrapper.findAll('[aria-label="Close scheduler"]')
    expect(closes, 'the view still renders its own close button').toHaveLength(0)
    expect(wrapper.findAll('.h-10'), 'the view still draws a 40px header row').toHaveLength(0)

    wrapper.unmount()
  })

  it('the source no longer references ui.closeScheduler — the shell closes the takeover', () => {
    expect(read(VIEW)).not.toContain('ui.closeScheduler')
  })
})

// ── AC-1 (source half) — the root is a well-behaved flex child ──────────────

describe('AC-1: the root is flex-1/min-h-0, never h-full', () => {
  it('the root element carries flex-1 and min-h-0 and not h-full', async () => {
    stubTakeoverShellTargets()
    const wrapper = mount(SchedulerView, { global: { plugins: [i18n] } })
    await settle()

    const root = wrapper.get('[data-dsqa="scheduler-takeover"]')
    const classes = root.classes()
    expect(classes).toContain('flex-1')
    expect(classes).toContain('min-h-0')
    expect(
      classes,
      'h-full means 100% of the SHELL, measured below its 40px header — the overflow this card fixes'
    ).not.toContain('h-full')

    wrapper.unmount()
  })

  it('the empty state root carries the same sizing', async () => {
    stubApi([])
    stubTakeoverShellTargets()
    const wrapper = mount(SchedulerView, { global: { plugins: [i18n] } })
    await settle()

    const root = wrapper.get('[data-dsqa="scheduler-empty"]')
    expect(root.classes()).toContain('flex-1')
    expect(root.classes()).not.toContain('h-full')

    wrapper.unmount()
  })
})

// ── AC-4 — the teleports carry `defer` and are the last root siblings ───────

describe('AC-4: the teleports are deferred and last', () => {
  it('both Teleports declare `defer`', () => {
    const src = read(VIEW)
    for (const target of ['#takeover-shell-icon', '#takeover-shell-actions']) {
      expect(src, `the ${target} Teleport is missing \`defer\``).toContain(
        `<Teleport to="${target}" defer>`
      )
    }
    expect(src.match(/<Teleport /g) ?? [], 'expected exactly two Teleports').toHaveLength(2)
  })

  it('the teleports are the LAST root siblings, after the body', () => {
    const src = read(VIEW)
    const template = src.slice(src.indexOf('<template>'))
    const firstTeleport = template.indexOf('<Teleport ')
    const bodyRoot = template.indexOf('data-dsqa')
    expect(bodyRoot).toBeGreaterThan(-1)
    expect(
      firstTeleport,
      'a Teleport placeholder as the first root breaks `wrapper.element` in Vue Test Utils'
    ).toBeGreaterThan(bodyRoot)
    // Nothing but the closing `</template>` follows the last Teleport.
    const afterLast = template.slice(template.lastIndexOf('</Teleport>') + '</Teleport>'.length)
    expect(afterLast.trim()).toBe('</template>')
  })

  it('opening the Scheduler as the FIRST takeover of a session still lands its icon', async () => {
    // The cold-mount case `defer` exists for: the shell's landing zones and
    // this view's Teleport source are created in the SAME synchronous pass.
    document.body.innerHTML = ''
    const ui = useUiStore()
    ui.toggleScheduler()

    const wrapper = mount(TakeoverHost, {
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    await settle()

    const icon = document.querySelector('#takeover-shell-icon')
    expect(
      icon?.querySelector('svg'),
      'the Scheduler icon never landed on a cold first mount — the Teleport resolved its target too early'
    ).not.toBeNull()

    wrapper.unmount()
  })
})

// ── AC-5 — the takeover mutex still holds both ways ─────────────────────────

describe('AC-5: the Scheduler participates in the takeover mutex', () => {
  const OTHERS = [
    ['roadmap', (ui: ReturnType<typeof useUiStore>) => ui.openRoadmap('/repo/alpha', 'alpha')],
    ['prStack', (ui: ReturnType<typeof useUiStore>) => ui.openPrStack('/repo/alpha', 'alpha')],
    ['usageDashboard', (ui: ReturnType<typeof useUiStore>) => ui.toggleUsageDashboard()],
    ['systemMonitor', (ui: ReturnType<typeof useUiStore>) => ui.toggleSystemMonitor()],
    ['cleanup', (ui: ReturnType<typeof useUiStore>) => ui.toggleCleanup()]
  ] as const

  it.each(OTHERS)('opening the Scheduler closes %s', (id, open) => {
    const ui = useUiStore()
    open(ui)
    expect(ui.activeView?.id).toBe(id)

    ui.openScheduler()
    expect(ui.activeView?.id).toBe('scheduler')
    expect(ui.schedulerOpen).toBe(true)
  })

  it.each(OTHERS)('opening %s closes the Scheduler', (id, open) => {
    const ui = useUiStore()
    ui.openScheduler()
    expect(ui.schedulerOpen).toBe(true)

    open(ui)
    expect(ui.activeView?.id).toBe(id)
    expect(ui.schedulerOpen).toBe(false)
  })
})
