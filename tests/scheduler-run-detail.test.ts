// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SchedulerWorkerDetail from '../src/renderer/src/components/SchedulerWorkerDetail.vue'
import { i18n } from '@renderer/i18n'
import type { Run, Worker } from '../src/preload'

/**
 * T303 — a stored run's own detail is reachable, and BUG-114/BUG-115 — the two
 * inert controls are gone.
 *
 * The Runs table always rendered five numbers per run and the newest run's
 * result. Every run's full `result`, `terminalReason` and `denials` were being
 * persisted 200 deep the whole time, so 199 of the 200 results existed on disk
 * and had no way to reach a screen. This asserts the disclosure, not the
 * storage — the storage was never the missing half.
 */

function run(over: Partial<Run> = {}): Run {
  return {
    workerId: 'w1',
    startedAt: Date.parse('2026-09-08T09:00:00.000Z'),
    endedAt: Date.parse('2026-09-08T09:00:20.000Z'),
    durationMs: 20_000,
    status: 'ok',
    result: '',
    terminalReason: '',
    numTurns: 3,
    costUsd: 0.02,
    tokens: { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 },
    denials: [],
    ...over
  }
}

const OLD = run({
  startedAt: Date.parse('2026-09-08T08:00:00.000Z'),
  result: 'Nothing changed since yesterday.',
  terminalReason: 'completed',
  denials: ['Edit ×9']
})
const SKIPPED = run({
  startedAt: Date.parse('2026-09-08T08:30:00.000Z'),
  status: 'stopped',
  result: '',
  terminalReason: 'stopped'
})
const NEWEST = run({ result: 'PR 292 opened', terminalReason: 'completed' })

const schedulerRuns = vi.fn(async () => [OLD, SKIPPED, NEWEST])

beforeEach(() => {
  schedulerRuns.mockClear()
  const api = {
    schedulerRuns,
    bundledSkillsGet: vi.fn(async () => ({ catalog: [], enabled: {} })),
    bundledSkillsGetFolder: vi.fn(async () => ({})),
    skillsAvailable: vi.fn(async () => [])
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get(t: Record<string, unknown>, k: string) {
      return k in t ? t[k] : () => () => {}
    }
  })
  setActivePinia(createPinia())
})

const WORKER: Worker = {
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
  notifyOn: 'silent',
  failureStreak: 0
}

function mountDetail() {
  return mount(SchedulerWorkerDetail, {
    props: { worker: WORKER, running: false, nowMs: Date.now() },
    global: { plugins: [i18n] }
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flushPromises()
}

async function openSettings(w: ReturnType<typeof mountDetail>): Promise<void> {
  const tab = w.findAll('button').find((b) => b.text() === 'Settings')
  await tab!.trigger('click')
  await settle()
}

describe("run row → that run's own detail", () => {
  it('shows nothing until a row is opened', async () => {
    const w = mountDetail()
    await settle()
    expect(w.find('[data-dsqa="run-detail"]').exists()).toBe(false)
    // The newest result is on screen (the LAST RESULT card); an older one is not.
    expect(w.text()).toContain('PR 292 opened')
    expect(w.text()).not.toContain('Nothing changed since yesterday.')
  })

  it('opens the result of the run that was clicked, not the newest one', async () => {
    const w = mountDetail()
    await settle()
    // Newest first, so the oldest run is the last row.
    const rows = w.findAll('[data-dsqa="run-row"]')
    expect(rows).toHaveLength(3)
    await rows[rows.length - 1].trigger('click')
    await settle()
    const detail = w.get('[data-dsqa="run-detail"]')
    expect(detail.text()).toContain('Nothing changed since yesterday.')
  })

  it("shows that run's terminal reason and its own denials", async () => {
    const w = mountDetail()
    await settle()
    const rows = w.findAll('[data-dsqa="run-row"]')
    await rows[rows.length - 1].trigger('click')
    await settle()
    const detail = w.get('[data-dsqa="run-detail"]')
    expect(detail.text()).toContain('completed')
    expect(detail.text()).toContain('Edit ×9')
  })

  it('a stopped run with no result reads as empty, not as a broken panel', async () => {
    const w = mountDetail()
    await settle()
    const rows = w.findAll('[data-dsqa="run-row"]')
    await rows[1].trigger('click')
    await settle()
    const detail = w.get('[data-dsqa="run-detail"]')
    expect(detail.text()).toContain('This run produced no result.')
  })

  it('opens one row at a time, and closes on a second click', async () => {
    const w = mountDetail()
    await settle()
    const rows = w.findAll('[data-dsqa="run-row"]')
    await rows[0].trigger('click')
    await settle()
    expect(w.findAll('[data-dsqa="run-detail"]')).toHaveLength(1)
    await rows[2].trigger('click')
    await settle()
    expect(w.findAll('[data-dsqa="run-detail"]')).toHaveLength(1)
    await rows[2].trigger('click')
    await settle()
    expect(w.findAll('[data-dsqa="run-detail"]')).toHaveLength(0)
  })

  /**
   * T306 — the disclosure is a real `<button>` INSIDE the row, not the `<tr>`
   * wearing `role="button"`.
   *
   * The row previously carried `role="button"` + `tabindex="0"` itself, which
   * replaces the row's semantics wholesale: assistive tech announces a button
   * instead of "row 3 of 12", and the `<td>`s lose their row ancestor. The row
   * stays clickable for the mouse — that affordance is in `design.md` — but the
   * control that owns `aria-expanded`/`aria-controls` is a focusable button.
   */
  it('keeps the row a row, and puts the disclosure control inside it', async () => {
    const w = mountDetail()
    await settle()
    const row = w.findAll('[data-dsqa="run-row"]')[0]
    expect(row.attributes('role')).toBe('row')
    expect(row.attributes('aria-expanded')).toBeUndefined()
    expect(row.attributes('tabindex')).toBeUndefined()

    const toggle = row.get('[data-dsqa="run-row-toggle"]')
    expect(toggle.element.tagName).toBe('BUTTON')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    // The control points at the row it opens, which is what makes the
    // relationship announceable rather than merely visual.
    expect(toggle.attributes('aria-controls')).toMatch(/^run-detail-\d+$/)

    await toggle.trigger('click')
    await settle()
    const openToggle = w.findAll('[data-dsqa="run-row-toggle"]')[0]
    expect(openToggle.attributes('aria-expanded')).toBe('true')
    // `aria-controls` resolves to the detail row that actually rendered.
    const detail = w.get('[data-dsqa="run-detail"]')
    expect(detail.attributes('id')).toBe(openToggle.attributes('aria-controls'))
  })

  it('the button toggles once, not twice, despite the row also being clickable', async () => {
    const w = mountDetail()
    await settle()
    const toggle = w.findAll('[data-dsqa="run-row-toggle"]')[0]
    await toggle.trigger('click')
    await settle()
    expect(w.findAll('[data-dsqa="run-detail"]')).toHaveLength(1)
  })

  it('never opens a dialog over the takeover', async () => {
    const w = mountDetail()
    await settle()
    await w.findAll('[data-dsqa="run-row"]')[0].trigger('click')
    await settle()
    expect(w.find('[role="dialog"]').exists()).toBe(false)
    // The detail lives inside the Runs column itself.
    const column = w.get('[data-dsqa="worker-detail-runs"]')
    expect(column.find('[data-dsqa="run-detail"]').exists()).toBe(true)
  })
})

describe('Settings tab — the two controls that did nothing are gone', () => {
  it('has no Provider picker (BUG-114)', async () => {
    const w = mountDetail()
    await settle()
    await openSettings(w)
    expect(w.text()).not.toContain('Provider')
    expect(w.text()).not.toContain('Manage…')
  })

  it('has no transcript toggle (BUG-115)', async () => {
    const w = mountDetail()
    await settle()
    await openSettings(w)
    const advanced = w.findAll('button').find((b) => b.text().includes('Advanced'))
    await advanced!.trigger('click')
    await settle()
    expect(w.text().toLowerCase()).not.toContain('transcript')
  })

  it('offers the three notification states, Silent selected by default', async () => {
    const w = mountDetail()
    await settle()
    await openSettings(w)
    const labels = w.findAll('[role="radio"]').map((r) => r.text())
    for (const state of ['Silent', 'On failure', 'Every run']) {
      expect(labels).toContain(state)
    }
    const silent = w.findAll('[role="radio"]').find((r) => r.text() === 'Silent')
    expect(silent!.attributes('aria-checked')).toBe('true')
  })
})
