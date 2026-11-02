// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import type { BudgetPrefs, BudgetSnapshot } from '../src/main/github-budget-core'
import GithubBudgetPill from '../src/renderer/src/components/GithubBudgetPill.vue'
import GithubBudgetPane from '../src/renderer/src/components/GithubBudgetPane.vue'
import { useGithubBudgetStore } from '../src/renderer/src/stores/github-budget'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { exhausted, healthy, low, prefs, unavailable, NOW } from './helpers/github-budget-snapshot'

/**
 * T611 U2 — the footer GitHub pill + popover (mockup `b--own-pill`) and Settings → GitHub API
 * (mockup `d--settings-pane`), driven through the budget store with the mockup's sample data.
 * The pixel match is mockup-qa's job (docs/specs/2026-11-02-github-rate-limit/); these tests pin
 * the numbers, the states and the wiring.
 */

const setPrefs = vi.fn(async (p: BudgetPrefs) => p)
let wrapper: VueWrapper | null = null

function stubApi(snap: BudgetSnapshot, missionViews: unknown[] = []): void {
  vi.stubGlobal(
    'window',
    Object.assign(globalThis.window, {
      api: {
        githubBudgetSnapshot: vi.fn(async () => snap),
        githubBudgetPrefs: vi.fn(async () => snap.prefs),
        githubBudgetSetPrefs: setPrefs,
        onGithubBudgetChanged: vi.fn(() => () => {}),
        prStackPrefs: vi.fn(async () => ({ autoRefresh: true, intervalMs: 90_000 })),
        missionList: vi.fn(async () => ({ views: missionViews })),
        notify: vi.fn()
      }
    })
  )
}

async function mountPill(snap: BudgetSnapshot): Promise<VueWrapper> {
  stubApi(snap)
  wrapper = mount(GithubBudgetPill, { attachTo: document.body, global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

async function mountPane(snap: BudgetSnapshot): Promise<VueWrapper> {
  stubApi(snap)
  // The pane reads the store the footer would have initialised.
  await useGithubBudgetStore().init()
  wrapper = mount(GithubBudgetPane, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  setPrefs.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('footer GitHub pill (AC-1)', () => {
  it('is hidden while the budget is unavailable', async () => {
    const w = await mountPill(unavailable())
    expect(w.find('[data-dsqa="github-footer-pill"]').exists()).toBe(false)
    expect(useUiStore().popoverAnchors.githubBudget).toBe(false)
  })

  it('healthy: calls left in the tighter bucket, quiet tone', async () => {
    const w = await mountPill(healthy())
    const pill = w.get('[data-dsqa="github-footer-pill"]')
    expect(pill.text()).toBe('4,112 left')
    expect(pill.classes()).toContain('text-text-2')
    expect(useUiStore().popoverAnchors.githubBudget).toBe(true)
  })

  it('low: warning tone', async () => {
    const w = await mountPill(low())
    const pill = w.get('[data-dsqa="github-footer-pill"]')
    expect(pill.text()).toBe('640 left')
    expect(pill.classes()).toContain('text-warning')
  })

  it('exhausted: red, with the reset countdown', async () => {
    const w = await mountPill(exhausted())
    const pill = w.get('[data-dsqa="github-footer-pill"]')
    expect(pill.text()).toBe('0 left · 12m')
    expect(pill.classes()).toContain('text-red')
  })
})

describe('footer GitHub pill — a limit GitHub did not put in `rate_limit`', () => {
  it('exhausted by a gh error while calls remain: the pill tells the truth, not "0 left"', async () => {
    const snap = exhausted()
    snap.rest!.bucket = { ...snap.rest!.bucket, remaining: 3116, used: 1884 }
    const w = await mountPill(snap)
    expect(w.get('[data-dsqa="github-footer-pill"]').text()).toBe('3,116 left · 12m')
  })
})

describe('popover (AC-2)', () => {
  async function open(snap: BudgetSnapshot): Promise<VueWrapper> {
    const w = await mountPill(snap)
    await w.get('[data-dsqa="github-footer-pill"]').trigger('click')
    await flushPromises()
    return w
  }

  it('healthy: REST and GraphQL meters with the Harnu / outside split and no note', async () => {
    const w = await open(healthy())
    const meters = w.get('[data-testid="gh-meters"]').text()
    expect(meters).toContain('REST · 5,000/h')
    expect(meters).toContain('4,112 left')
    expect(meters).toContain('GraphQL · 5,000 pts/h')
    expect(meters).toContain('4,690 left')
    expect(meters).toContain('resets in 38m')
    const consumers = w.get('[data-testid="gh-consumers"]').text()
    expect(consumers).toContain('Missions · PR and CI')
    expect(consumers).toContain('412')
    expect(consumers).toContain('Outside Harnu')
    expect(consumers).toContain('306')
    expect(w.text()).toContain('Harnu 582')
    expect(w.text()).toContain('Outside Harnu 306')
    expect(w.find('[data-testid="gh-note"]').exists()).toBe(false)
  })

  it('names the 80/95 ramp on the fill colours', async () => {
    const w = await open(low())
    const fills = w.findAll('[data-testid="gh-meters"] .rounded-full > div')
    expect(fills[0].classes()).toContain('bg-accent') // REST 87% used
    expect(fills[1].classes()).toContain('bg-green') // GraphQL 20% used
  })

  it('low: tags Missions as slowed and says what Harnu changed', async () => {
    const w = await open(low())
    expect(w.get('[data-consumer="missions"]').text()).toContain('slowed')
    expect(w.get('[data-testid="gh-meters"]').text()).toContain('at this pace, empty in 7m')
    const note = w.get('[data-testid="gh-note"]').text()
    expect(note).toContain('Harnu is polling slower.')
    expect(note).toContain('PR Stack refreshes on open')
  })

  it('low with the PR Stack pause off: the note does not promise it', async () => {
    const w = await open(low({ pausePrStackWhenLow: false }))
    expect(w.get('[data-testid="gh-note"]').text()).not.toContain('PR Stack')
  })

  it('exhausted: every Harnu consumer reads paused and the note is the limit note', async () => {
    const w = await open(exhausted())
    for (const c of ['missions', 'pr-stack', 'review', 'cleanup', 'steward']) {
      expect(w.get(`[data-consumer="${c}"]`).text()).toContain('paused')
    }
    expect(w.get('[data-testid="gh-meters"]').text()).toContain('0 left')
    expect(w.get('[data-testid="gh-meters"]').text()).toContain('(in 12m)')
    expect(w.get('[data-testid="gh-note"]').text()).toContain('Limit reached.')
  })

  it('shows the @login in the header, and drops it when there is none', async () => {
    const withLogin = { ...healthy(), login: 'junielton' }
    let w = await open(withLogin)
    expect(w.get('[data-testid="gh-popover-updated"]').text()).toBe('@junielton · updated 20s ago')
    w.unmount()
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    w = await open(healthy())
    expect(w.get('[data-testid="gh-popover-updated"]').text()).toBe('updated 20s ago')
  })

  it('Details closes the popover and opens Settings → GitHub API', async () => {
    const w = await open(low())
    const ui = useUiStore()
    expect(ui.popovers.githubBudget).toBe(true)
    await w.get('[data-testid="gh-details"]').trigger('click')
    expect(ui.popovers.githubBudget).toBe(false)
    expect(ui.dialog).toBe('settings')
    expect(ui.settingsTab).toBe('githubApi')
  })

  it('closes on Esc', async () => {
    await open(healthy())
    const ui = useUiStore()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(ui.popovers.githubBudget).toBe(false)
  })
})

describe('Settings → GitHub API (AC-3)', () => {
  it('default: tiles, pace, the table with cadence and no banner', async () => {
    const w = await mountPane(healthy())
    expect(w.find('[data-testid="gh-pane-banner"]').exists()).toBe(false)
    const tiles = w.get('[data-testid="gh-tiles"]').text()
    expect(tiles).toContain('4,112')
    expect(tiles).toContain('left of 5,000')
    expect(tiles).toContain('4,690')
    expect(tiles).toContain('31')
    expect(tiles).toContain('lasts past the reset')
    expect(tiles).toContain('Harnu 18/min · outside 13/min')
    expect(w.findAll('[data-testid="gh-chart-col"]')).toHaveLength(12)
    const missions = w.get('[data-row="missions"]').text()
    expect(missions).toContain('412')
    expect(missions).toContain('46%')
    expect(missions).toContain('1 min')
    expect(w.get('[data-row="pr-stack"]').text()).toContain('2 min')
    expect(w.get('[data-row="review"]').text()).toContain('on open')
    expect(w.get('[data-row="steward"]').text()).toContain('on event')
    expect(w.get('[data-row="outside"]').text()).toContain('34%')
  })

  it('throttled: the banner says since when, and the cadence column shows what changed', async () => {
    const w = await mountPane(low())
    const banner = w.get('[data-testid="gh-pane-banner"]').text()
    expect(banner).toContain('Harnu has been slowing down since')
    expect(banner).toContain('REST budget dropped below 15%')
    const missions = w.get('[data-row="missions"]')
    expect(missions.find('s').text()).toBe('1 min')
    expect(missions.text()).toContain('5 min')
    expect(w.get('[data-row="pr-stack"]').text()).toContain('on open')
    expect(w.get('[data-row="review"]').find('s').exists()).toBe(false)
    expect(w.get('[data-testid="gh-tiles"]').text()).toContain('empty in 7m')
  })

  it('exhausted: a red banner and paused rows', async () => {
    const w = await mountPane(exhausted())
    expect(w.get('[data-testid="gh-pane-banner"]').text()).toContain('REST limit reached.')
    expect(w.get('[data-row="missions"]').text()).toContain('paused')
  })

  it('lists delivered missions as not checked, until the switch is on', async () => {
    stubApi(healthy(), [
      { mission: { id: 'a', status: 'delivered' } },
      { mission: { id: 'b', status: 'delivered' } },
      { mission: { id: 'c', status: 'delivered' } },
      { mission: { id: 'd', status: 'active' } }
    ])
    await useGithubBudgetStore().init()
    wrapper = mount(GithubBudgetPane, { global: { plugins: [i18n] } })
    await flushPromises()
    const row = wrapper.get('[data-row="delivered"]').text()
    expect(row).toContain('3 delivered missions')
    expect(row).toContain('not checked')
  })

  it('writes every control to U1 prefs', async () => {
    const w = await mountPane(healthy())

    await w.get('[data-test="gh-check-delivered"]').trigger('click')
    expect(setPrefs).toHaveBeenLastCalledWith(prefs({ checkDelivered: true }))

    await w.get('[data-test="gh-pause-pr-stack"]').trigger('click')
    expect(setPrefs).toHaveBeenLastCalledWith(
      prefs({ checkDelivered: true, pausePrStackWhenLow: false })
    )

    await w.get('[data-test="gh-notify"]').trigger('click')
    expect(setPrefs).toHaveBeenLastCalledWith(
      prefs({ checkDelivered: true, pausePrStackWhenLow: false, notify: false })
    )

    const buttons = w.findAll('button').filter((b) => ['10%', '15%', '25%'].includes(b.text()))
    expect(buttons.map((b) => b.text())).toEqual(['10%', '15%', '25%'])
    await buttons[2].trigger('click')
    expect(setPrefs).toHaveBeenLastCalledWith(
      prefs({ checkDelivered: true, pausePrStackWhenLow: false, notify: false, threshold: 25 })
    )
  })

  it('says so, instead of an empty page, when the budget is unavailable', async () => {
    const w = await mountPane(unavailable())
    expect(w.get('[data-testid="gh-pane-unavailable"]').text()).toContain('unavailable')
  })

  it('names the gh user in the intro when U1 reports one', async () => {
    const w = await mountPane({ ...healthy(), login: 'junielton' })
    expect(w.get('[data-testid="gh-pane-login"]').text()).toBe('@junielton')
  })
})
