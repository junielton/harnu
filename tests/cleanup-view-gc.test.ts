// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import CleanupView from '../src/renderer/src/components/CleanupView.vue'
import { i18n } from '@renderer/i18n'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { defaultGcPrefs, type GcPrefs } from '../src/main/gc/gc-prefs'
import type { GcJobInfo, GcSnapshot } from '../src/main/gc/gc-wire'
import { GIB, MIB, decideReason, snapshotOf, volume, wt } from './helpers/cleanup-gc-fixtures'

/**
 * The assembled Cleanup screen against a stubbed `window.api`: the hero's one confirm, the selection
 * bar's Remove selected, the first-cycle prompt, the background chip and the panel. The pieces have
 * their own tests; this one pins how they are wired together and what reaches `gc:clean`.
 */

const t = (key: string, named?: Record<string, unknown>): string =>
  (named ? i18n.global.t(key, named) : i18n.global.t(key)) as string

function snap(over: Partial<GcSnapshot> = {}, prefs: Partial<GcPrefs> = {}): GcSnapshot {
  return {
    ...snapshotOf(
      [
        wt('c1', 'corpse', 500 * MIB),
        wt('c2', 'corpse', 400 * MIB),
        wt('d1', 'decide', 2 * GIB, {}, { reason: decideReason('dirty') }),
        wt('d2', 'decide', 1 * GIB, {}, { reason: decideReason('closed-unmerged') }),
        wt('a1', 'alive', 1 * GIB)
      ],
      [volume('pg_old', 'old-app', 300 * MIB)]
    ),
    ...over,
    prefs: { ...defaultGcPrefs(), autopilot: true, firstReportAcknowledged: true, ...prefs }
  }
}

interface Api {
  gcSnapshot: ReturnType<typeof vi.fn>
  gcClean: ReturnType<typeof vi.fn>
  gcKeep: ReturnType<typeof vi.fn>
  gcJobs: ReturnType<typeof vi.fn>
  gcAckFirstReport: ReturnType<typeof vi.fn>
  gcSetPrefs: ReturnType<typeof vi.fn>
}

function install(first: GcSnapshot, jobs: GcJobInfo[] = []): Api {
  const api: Api = {
    gcSnapshot: vi.fn(async () => first),
    gcClean: vi.fn(async () => ({ jobId: 'j1', queued: false })),
    gcKeep: vi.fn(async () => defaultGcPrefs()),
    gcJobs: vi.fn(async () => jobs),
    gcAckFirstReport: vi.fn(async () => defaultGcPrefs()),
    gcSetPrefs: vi.fn(async (p: unknown) => p)
  }
  const full = {
    ...api,
    gcPrefs: vi.fn(async () => first.prefs),
    reaperSnapshot: vi.fn(async () => ({ scannedAt: Date.now(), repos: [] })),
    reaperScan: vi.fn(async () => ({ scannedAt: Date.now(), repos: [] })),
    reaperJournal: vi.fn(async () => []),
    reaperPrefs: vi.fn(async () => ({ dehydrateIdleDays: 7 }))
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(full, {
    get: (t2: Record<string, unknown>, k: string) => (k in t2 ? t2[k] : () => () => {})
  })
  return api
}

let wrapper: VueWrapper | null = null

async function mountView(): Promise<VueWrapper> {
  // The view teleports its header icon into the TakeoverShell; without a target the deferred
  // teleport never mounts its child, and the next patch of it throws.
  const slot = document.createElement('span')
  slot.id = 'takeover-shell-icon'
  document.body.appendChild(slot)
  wrapper = mount(CleanupView, {
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

// The view is a fragment (toolbar, selection bar, body, dialogs), so wrapper.find() would only see
// its first root. Query the attached document and dispatch real DOM events instead.
class Q {
  constructor(readonly el: Element | null) {}
  exists(): boolean {
    return this.el !== null
  }
  text(): string {
    return (this.el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  }
  attributes(name: string): string | undefined {
    return this.el?.getAttribute(name) ?? undefined
  }
  async trigger(type: string, init: MouseEventInit & KeyboardEventInit = {}): Promise<void> {
    this.el?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
    await flushPromises()
  }
  async setValue(v: boolean): Promise<void> {
    const input = this.el as HTMLInputElement
    input.checked = v
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
  }
}
function dom(sel: string): Q {
  return new Q(document.body.querySelector(sel))
}
function domGet(sel: string): Q {
  const q = dom(sel)
  if (!q.exists()) throw new Error(`not found: ${sel}`)
  return q
}
function domAll(sel: string): Q[] {
  return Array.from(document.body.querySelectorAll(sel)).map((e) => new Q(e))
}
const body = (id: string): HTMLElement | null =>
  document.body.querySelector(`[data-testid="${id}"]`)

describe('Cleanup screen — hero and the one confirm', () => {
  it('shows the corpse count in the hero and opens ONE dialog that lists every corpse', async () => {
    install(snap())
    await mountView()
    const hero = domGet('[data-testid="hero-clean"]')
    expect(hero.text()).toContain('2')
    await hero.trigger('click')
    await flushPromises()
    expect(body('bulk-dialog')).not.toBeNull()
    expect(document.body.querySelectorAll('[data-testid="bulk-row"]')).toHaveLength(2)
  })

  it('confirming sends the corpse ids with expected facts and NO confirmed list', async () => {
    const api = install(snap())
    await mountView()
    await domGet('[data-testid="hero-clean"]').trigger('click')
    await flushPromises()
    ;(body('bulk-confirm') as HTMLButtonElement).click()
    await flushPromises()
    expect(api.gcClean).toHaveBeenCalledTimes(1)
    const [ids, opts] = api.gcClean.mock.calls[0]
    expect(ids).toHaveLength(2)
    expect(opts.confirmed).toBeUndefined()
    expect(Object.keys(opts.expected)).toEqual(ids)
    expect('confirmDecide' in opts).toBe(false)
    expect(body('bulk-dialog')).toBeNull() // closed at once; the job runs in the background
  })

  it('cancelling the dialog sends nothing', async () => {
    const api = install(snap())
    await mountView()
    await domGet('[data-testid="hero-clean"]').trigger('click')
    await flushPromises()
    ;(body('bulk-cancel') as HTMLButtonElement).click()
    await flushPromises()
    expect(api.gcClean).not.toHaveBeenCalled()
    expect(body('bulk-dialog')).toBeNull()
  })

  it('with nothing to clean the hero is disabled and says so', async () => {
    install(snap({ bundles: [wt('d1', 'decide', GIB, {}, { reason: decideReason('dirty') })] }))
    await mountView()
    const hero = domGet('[data-testid="hero-empty"]')
    expect(hero.attributes('disabled')).toBeDefined()
    expect(hero.text()).toBe(t('cleanup.gc.hero.empty'))
  })
})

describe('Cleanup screen — multi-select on Decide', () => {
  it('checking rows shows the selection bar; Remove selected confirms every id explicitly', async () => {
    const api = install(snap())
    await mountView()
    expect(dom('[data-testid="sel-remove"]').exists()).toBe(false)
    const checks = domAll('[data-testid="needs-you-check"]')
    expect(checks.length).toBeGreaterThanOrEqual(2)
    await checks[0].setValue(true)
    await checks[1].setValue(true)
    await flushPromises()
    await domGet('[data-testid="sel-remove"]').trigger('click')
    await flushPromises()
    expect(body('bulk-dialog')).not.toBeNull()
    ;(body('bulk-confirm') as HTMLButtonElement).click()
    await flushPromises()
    const [ids, opts] = api.gcClean.mock.calls[0]
    expect(ids).toHaveLength(2)
    expect(opts.confirmed).toEqual(ids)
    expect(Object.keys(opts.expected).sort()).toEqual([...ids].sort())
    expect('confirmDecide' in opts).toBe(false)
  })

  it('"Ask for an opinion" is visible but disabled', async () => {
    install(snap())
    await mountView()
    await domAll('[data-testid="needs-you-check"]')[0].setValue(true)
    await flushPromises()
    expect(domGet('[data-testid="sel-ask"]').attributes('disabled')).toBeDefined()
  })

  it('Shift+click on a Decide block checks it; a plain click opens its panel instead', async () => {
    install(snap())
    await mountView()
    const decide = domAll('[data-testid="treemap-block"][data-bucket="decide"]')[0]
    await decide.trigger('click', { shiftKey: true })
    await flushPromises()
    expect(dom('[data-testid="sel-remove"]').exists()).toBe(true)
    expect(dom('[data-testid="block-panel"]').exists()).toBe(false)
    const other = domAll('[data-testid="treemap-block"][data-bucket="decide"]')[1]
    await other.trigger('click')
    await flushPromises()
    expect(dom('[data-testid="block-panel"]').exists()).toBe(true)
  })

  it('Esc clears the selection first, then closes the panel', async () => {
    install(snap())
    await mountView()
    const decide = domAll('[data-testid="treemap-block"][data-bucket="decide"]')
    await decide[0].trigger('click', { shiftKey: true })
    await decide[1].trigger('click')
    await flushPromises()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(dom('[data-testid="sel-remove"]').exists()).toBe(false)
    expect(dom('[data-testid="block-panel"]').exists()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(dom('[data-testid="block-panel"]').exists()).toBe(false)
  })
})

describe('Cleanup screen — panel', () => {
  it('a Decide block opens its panel with the reason; Keep goes to the engine', async () => {
    const api = install(snap())
    await mountView()
    await domAll('[data-testid="treemap-block"][data-bucket="decide"]')[0].trigger('click')
    await flushPromises()
    expect(dom('[data-testid="panel-reason"]').exists()).toBe(true)
    expect(domGet('[data-testid="panel-ask"]').attributes('disabled')).toBeDefined()
    await domGet('[data-testid="panel-keep"]').trigger('click')
    await flushPromises()
    expect(api.gcKeep).toHaveBeenCalledTimes(1)
  })

  it('an orphan volume shows its project and "no known worktree"', async () => {
    install(snap())
    await mountView()
    const rows = domAll('[data-testid="needs-you-row"]')
    const volumeRow = rows.find((r) => r.text().includes('pg_old'))!
    expect(volumeRow.text()).toContain('old-app')
    await volumeRow.trigger('click')
    await flushPromises()
    expect(domGet('[data-testid="block-panel"]').text()).toContain(
      t('cleanup.gc.reason.noKnownWorktree')
    )
  })

  it('Remove in the panel uses the same dialog, in Decide mode', async () => {
    const api = install(snap())
    await mountView()
    await domAll('[data-testid="treemap-block"][data-bucket="decide"]')[0].trigger('click')
    await flushPromises()
    await domGet('[data-testid="panel-remove"]').trigger('click')
    await flushPromises()
    ;(body('bulk-confirm') as HTMLButtonElement).click()
    await flushPromises()
    expect(api.gcClean.mock.calls[0][1].confirmed).toHaveLength(1)
  })
})

describe('Cleanup screen — first cycle and background run', () => {
  it('the first-cycle banner enables autopilot: acknowledges AND sets the pref', async () => {
    const api = install(snap({}, { autopilot: false, firstReportAcknowledged: false }))
    await mountView()
    expect(dom('[data-testid="first-enable"]').exists()).toBe(true)
    await domGet('[data-testid="first-enable"]').trigger('click')
    await flushPromises()
    expect(api.gcAckFirstReport).toHaveBeenCalledTimes(1)
    expect(api.gcSetPrefs.mock.calls[0][0].autopilot).toBe(true)
  })

  it('no banner once the first report is acknowledged', async () => {
    install(snap())
    await mountView()
    expect(dom('[data-testid="first-enable"]').exists()).toBe(false)
  })

  it('a job running when the view opens re-attaches: the hero is the progress chip', async () => {
    const running: GcJobInfo = {
      jobId: 'j9',
      kind: 'manual',
      state: 'running',
      done: 3,
      total: 12,
      freedBytes: 1400 * MIB,
      current: null,
      results: [],
      error: null
    }
    install(snap(), [running])
    await mountView()
    expect(dom('[data-testid="hero-clean"]').exists()).toBe(false)
    expect(domGet('[data-testid="hero-chip"]').text()).toContain('3')
    expect(domGet('[data-testid="hero-chip"]').text()).toContain('12')
  })

  it('summary line shows the reclaimable total and the autopilot state', async () => {
    install(snap())
    await mountView()
    const text = domGet('[data-testid="cleanup-summary"]').text()
    expect(text).toContain(t('cleanup.gc.status.autopilotOn'))
  })
})

describe('Cleanup screen — all clean', () => {
  it('shows "All clean" with the hero disabled', async () => {
    install(snap({ bundles: [wt('a1', 'alive', GIB)], orphanVolumes: [] }))
    await mountView()
    expect(dom('[data-testid="cleanup-all-clean"]').exists()).toBe(true)
    expect(dom('[data-testid="hero-empty"]').exists()).toBe(true)
  })
})

describe('Cleanup screen — one door', () => {
  it('"Inspect stacks" in the Docker card opens the Containers inspector', async () => {
    install(snap())
    await mountView()
    await dom('[data-testid="docker-inspect"]').trigger('click')
    expect(useUiStore().activeView?.id).toBe('containers')
  })
})
