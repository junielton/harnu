// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import CleanupView from '../src/renderer/src/components/CleanupView.vue'
import { i18n } from '@renderer/i18n'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { defaultGcPrefs, type GcPrefs } from '../src/main/gc/gc-prefs'
import type { GcJobInfo, GcSnapshot } from '../src/main/gc/gc-wire'
import { refusalFor } from '../src/main/gc/autopilot-core'
import { ipcFn } from './helpers/ipc-clone'
import { GIB, MIB, reviewReason, snapshotOf, volume, wt } from './helpers/cleanup-gc-fixtures'

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
        wt('c1', 'ready', 500 * MIB),
        wt('c2', 'ready', 400 * MIB),
        wt('d1', 'review', 2 * GIB, {}, { reason: reviewReason('dirty') }),
        wt('d2', 'review', 1 * GIB, {}, { reason: reviewReason('closed-unmerged') }),
        wt('a1', 'in-use', 1 * GIB)
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
  gcRecheck: ReturnType<typeof vi.fn>
  gcSetPrefs: ReturnType<typeof vi.fn>
  push: Record<string, (p: unknown) => void>
}

interface ReaperStubs {
  /** What `reaper:snapshot` answers at mount; null = no scan has ever run. */
  snapshot?: () => Promise<unknown>
  scan?: () => Promise<unknown>
}

function install(first: GcSnapshot, jobs: GcJobInfo[] = [], reaper: ReaperStubs = {}): Api {
  const push: Api['push'] = {}
  const sub =
    (name: string) =>
    (cb: (p: unknown) => void): (() => void) => {
      push[name] = cb
      return () => delete push[name]
    }
  const api: Api = {
    push,
    gcSnapshot: ipcFn(async () => first),
    gcClean: ipcFn(async () => ({ jobId: 'j1', queued: false })),
    gcKeep: ipcFn(async () => defaultGcPrefs()),
    gcJobs: ipcFn(async () => jobs),
    gcAckFirstReport: ipcFn(async () => defaultGcPrefs()),
    gcRecheck: ipcFn(async (id: string) => ({ id, outcome: 'cleared' })),
    gcSetPrefs: ipcFn(async (p: unknown) => p)
  }
  const full = {
    ...api,
    gcPrefs: ipcFn(async () => first.prefs),
    onGcProgress: sub('progress'),
    onGcDone: sub('done'),
    onGcCycle: sub('cycle'),
    reaperSnapshot: ipcFn(reaper.snapshot ?? (async () => ({ scannedAt: Date.now(), repos: [] }))),
    reaperScan: ipcFn(reaper.scan ?? (async () => ({ scannedAt: Date.now(), repos: [] }))),
    reaperJournal: ipcFn(async () => []),
    reaperPrefs: ipcFn(async () => ({ dehydrateIdleDays: 7 }))
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
  it('shows the ready count in the hero and opens ONE dialog that lists every ready item', async () => {
    install(snap())
    await mountView()
    const hero = domGet('[data-testid="hero-clean"]')
    expect(hero.text()).toContain('2')
    await hero.trigger('click')
    await flushPromises()
    expect(body('bulk-dialog')).not.toBeNull()
    expect(document.body.querySelectorAll('[data-testid="bulk-row"]')).toHaveLength(2)
  })

  it('confirming sends the ready ids with expected facts and NO confirmed list', async () => {
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
    install(snap({ bundles: [wt('d1', 'review', GIB, {}, { reason: reviewReason('dirty') })] }))
    await mountView()
    const hero = domGet('[data-testid="hero-empty"]')
    expect(hero.attributes('disabled')).toBeDefined()
    expect(hero.text()).toBe(t('cleanup.gc.hero.empty'))
  })
})

describe('Cleanup screen — multi-select on Needs review', () => {
  it('checking rows shows the selection bar; Remove selected confirms every id explicitly', async () => {
    const api = install(snap())
    await mountView()
    expect(dom('[data-testid="sel-remove"]').exists()).toBe(false)
    const checks = domAll('[data-testid="review-check"]')
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

  it('Shift+click on a Needs review block checks it; a plain click opens its panel instead', async () => {
    install(snap())
    await mountView()
    const review = domAll('[data-testid="treemap-block"][data-bucket="review"]')[0]
    await review.trigger('click', { shiftKey: true })
    await flushPromises()
    expect(dom('[data-testid="sel-remove"]').exists()).toBe(true)
    expect(dom('[data-testid="block-panel"]').exists()).toBe(false)
    const other = domAll('[data-testid="treemap-block"][data-bucket="review"]')[1]
    await other.trigger('click')
    await flushPromises()
    expect(dom('[data-testid="block-panel"]').exists()).toBe(true)
  })

  it('Esc clears the selection first, then closes the panel', async () => {
    install(snap())
    await mountView()
    const review = domAll('[data-testid="treemap-block"][data-bucket="review"]')
    await review[0].trigger('click', { shiftKey: true })
    await review[1].trigger('click')
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
  it('a Needs review block opens its panel with the reason; Keep goes to the engine', async () => {
    const api = install(snap())
    await mountView()
    await domAll('[data-testid="treemap-block"][data-bucket="review"]')[0].trigger('click')
    await flushPromises()
    expect(dom('[data-testid="panel-reason"]').exists()).toBe(true)
    expect(domGet('[data-testid="panel-ask"]').attributes('disabled')).toBeUndefined()
    await domGet('[data-testid="panel-keep"]').trigger('click')
    await flushPromises()
    expect(api.gcKeep).toHaveBeenCalledTimes(1)
  })

  it('an orphan volume shows its project and "no known worktree"', async () => {
    install(snap())
    await mountView()
    const rows = domAll('[data-testid="review-row"]')
    const volumeRow = rows.find((r) => r.text().includes('pg_old'))!
    expect(volumeRow.text()).toContain('old-app')
    await volumeRow.trigger('click')
    await flushPromises()
    expect(domGet('[data-testid="block-panel"]').text()).toContain(
      t('cleanup.gc.reason.noKnownWorktree')
    )
  })

  it('Remove in the panel uses the same dialog, in Needs review mode', async () => {
    const api = install(snap())
    await mountView()
    await domAll('[data-testid="treemap-block"][data-bucket="review"]')[0].trigger('click')
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

  it('Enable autopilot leaves the prefs with autopilot AND the report acknowledged — through a real clone', async () => {
    // A stateful stand-in for main: it keeps what it was sent, as the real prefs store does.
    const first = snap({}, { autopilot: false, firstReportAcknowledged: false })
    let stored: GcPrefs = first.prefs
    const api = install(first)
    api.gcSetPrefs.mockImplementation(async (p: unknown) => {
      stored = { ...(p as GcPrefs), firstReportAcknowledged: stored.firstReportAcknowledged }
      return stored
    })
    api.gcAckFirstReport.mockImplementation(async () => {
      stored = { ...stored, firstReportAcknowledged: true }
      return stored
    })
    await mountView()
    await domGet('[data-testid="first-enable"]').trigger('click')
    await flushPromises()
    expect(stored.autopilot).toBe(true)
    expect(stored.firstReportAcknowledged).toBe(true)
  })

  it('a failed Enable autopilot reports it, keeps the banner and lets the operator retry', async () => {
    const api = install(snap({}, { autopilot: false, firstReportAcknowledged: false }))
    await mountView()
    const toast = vi.spyOn(useUiStore(), 'pushToast')
    api.gcSetPrefs.mockRejectedValueOnce(new Error('ipc exploded'))
    await domGet('[data-testid="first-enable"]').trigger('click')
    await flushPromises()
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0][0]).toMatchObject({
      kind: 'danger',
      title: t('cleanup.gc.error.autopilot')
    })
    expect(toast.mock.calls[0][0].description).toContain('ipc exploded')
    expect(api.gcAckFirstReport).not.toHaveBeenCalled() // nothing was acknowledged behind the failure
    expect(dom('[data-testid="first-enable"]').exists()).toBe(true)
    expect(domGet('[data-testid="first-enable"]').attributes('disabled')).toBeUndefined()
  })

  it('the banner buttons are disabled while an action is in flight', async () => {
    const api = install(snap({}, { autopilot: false, firstReportAcknowledged: false }))
    let release: (v: GcPrefs) => void = () => {}
    api.gcSetPrefs.mockImplementationOnce(() => new Promise<GcPrefs>((r) => (release = r)))
    await mountView()
    await domGet('[data-testid="first-enable"]').trigger('click')
    await flushPromises()
    expect(domGet('[data-testid="first-enable"]').attributes('disabled')).toBeDefined()
    expect(domGet('[data-testid="first-dismiss"]').attributes('disabled')).toBeDefined()
    release(defaultGcPrefs())
    await flushPromises()
  })

  it('"Not now" acknowledges through a real clone and reports a failure', async () => {
    const api = install(snap({}, { autopilot: false, firstReportAcknowledged: false }))
    await mountView()
    const toast = vi.spyOn(useUiStore(), 'pushToast')
    api.gcAckFirstReport.mockRejectedValueOnce(new Error('nope'))
    await domGet('[data-testid="first-dismiss"]').trigger('click')
    await flushPromises()
    expect(toast.mock.calls[0][0]).toMatchObject({ title: t('cleanup.gc.error.dismiss') })
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
    install(snap({ bundles: [wt('a1', 'in-use', GIB)], orphanVolumes: [] }))
    await mountView()
    expect(dom('[data-testid="cleanup-all-clean"]').exists()).toBe(true)
    expect(dom('[data-testid="hero-empty"]').exists()).toBe(true)
  })
})

describe('Cleanup screen — before the first scan (BUG-171)', () => {
  const empty = (): GcSnapshot => snap({ bundles: [], orphanVolumes: [] })

  it('says it is scanning — never "All clean" — and disables the hero until the scan ends', async () => {
    let finish!: (v: unknown) => void
    const scan = new Promise((r) => (finish = r))
    const api = install(empty(), [], { snapshot: async () => null, scan: () => scan })
    await mountView()

    expect(dom('[data-testid="cleanup-scanning"]').text()).toContain(
      t('cleanup.gc.firstScan.title')
    )
    expect(dom('[data-testid="cleanup-all-clean"]').exists()).toBe(false)
    expect(dom('[data-testid="treemap"]').exists()).toBe(false)
    expect(dom('[data-testid="docker-card"]').exists()).toBe(false)
    const hero = domGet('[data-testid="hero-scanning"]')
    expect(hero.text()).toBe(t('cleanup.gc.firstScan.hero'))
    expect((hero.el as HTMLButtonElement).disabled).toBe(true)
    expect(dom('[data-testid="hero-empty"]').exists()).toBe(false)
    // The summary does not claim "0 B reclaimable" either.
    expect(domGet('[data-testid="cleanup-summary"]').text()).toBe(t('cleanup.gc.firstScan.title'))

    const before = api.gcSnapshot.mock.calls.length
    finish({ scannedAt: Date.now(), repos: [] })
    await flushPromises()
    // The gather is read again after the scan, and only then may the screen draw a result.
    expect(api.gcSnapshot.mock.calls.length).toBeGreaterThan(before)
    expect(dom('[data-testid="cleanup-scanning"]').exists()).toBe(false)
    expect(dom('[data-testid="cleanup-all-clean"]').exists()).toBe(true)
  })

  it('draws the worktrees the scan found, not an empty first gather', async () => {
    let scanned = false
    const api = install(empty(), [], {
      snapshot: async () => null,
      scan: async () => {
        scanned = true
        return { scannedAt: Date.now(), repos: [] }
      }
    })
    api.gcSnapshot.mockImplementation(async () => (scanned ? snap() : empty()))
    await mountView()
    expect(dom('[data-testid="cleanup-all-clean"]').exists()).toBe(false)
    expect(dom('[data-testid="hero-clean"]').exists()).toBe(true)
  })

  it('reports a failed first scan instead of staying on "Scanning…" or claiming it is clean', async () => {
    install(empty(), [], {
      snapshot: async () => null,
      scan: async () => {
        throw new Error('git is not on the PATH')
      }
    })
    await mountView()
    expect(dom('[data-testid="cleanup-scanning"]').exists()).toBe(false)
    expect(dom('[data-testid="cleanup-all-clean"]').exists()).toBe(false)
    expect(domGet('[data-testid="cleanup-scan-failed"]').text()).toContain('git is not on the PATH')
    // The rescan button is still there to try again.
    expect((domGet('[data-testid="cleanup-rescan"]').el as HTMLButtonElement).disabled).toBe(false)
  })

  it('an already scanned workspace shows no scanning state at all', async () => {
    install(snap())
    await mountView()
    expect(dom('[data-testid="cleanup-scanning"]').exists()).toBe(false)
    expect(dom('[data-testid="hero-scanning"]').exists()).toBe(false)
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

describe('Cleanup screen — Retry follows the bucket', () => {
  async function failed(api: Api, id: string): Promise<void> {
    api.push.done({
      jobId: 'j1',
      kind: 'manual',
      done: 0,
      total: 1,
      freedBytes: 0,
      results: [{ id, ok: false, haltedAt: 'trash', error: 'EBUSY', freedBytes: 0 }],
      error: null
    })
    await flushPromises()
  }
  const blockId = (bucket: string, n = 0): string =>
    document.body
      .querySelectorAll(`[data-testid="treemap-block"][data-bucket="${bucket}"]`)
      [n].getAttribute('data-block-id')!

  it('a failed ready item opens the ready confirm for that one id — and confirming sends it', async () => {
    const api = install(snap())
    await mountView()
    const id = blockId('ready')
    await failed(api, id)
    await dom(`[data-block-id="${id}"]`).trigger('click')
    await dom('[data-testid="panel-retry"]').trigger('click')
    expect(body('bulk-dialog')).not.toBeNull()
    expect(document.body.querySelectorAll('[data-testid="bulk-row"]')).toHaveLength(1)
    ;(body('bulk-confirm') as HTMLButtonElement).click()
    await flushPromises()
    const [ids, opts] = api.gcClean.mock.calls[0]
    expect(ids).toEqual([id])
    expect(opts.confirmed).toBeUndefined() // a ready item needs no confirmation of its own
    expect(opts.expected[id].bucket).toBe('ready')
  })

  it('a failed review item opens the review confirm — Danger, and confirmed', async () => {
    const api = install(snap())
    await mountView()
    const id = blockId('review')
    await failed(api, id)
    await dom(`[data-block-id="${id}"]`).trigger('click')
    await dom('[data-testid="panel-retry"]').trigger('click')
    expect(body('bulk-confirm')!.className).toContain('text-red')
    ;(body('bulk-confirm') as HTMLButtonElement).click()
    await flushPromises()
    const [ids, opts] = api.gcClean.mock.calls[0]
    expect(ids).toEqual([id])
    expect(opts.confirmed).toEqual([id])
  })

  it('never opens a dialog that would send nothing', async () => {
    const api = install(snap())
    await mountView()
    const id = blockId('in-use')
    await failed(api, id)
    await dom(`[data-block-id="${id}"]`).trigger('click')
    expect(dom('[data-testid="panel-retry"]').exists()).toBe(false)
    expect(api.gcClean).not.toHaveBeenCalled()
  })
})

describe('Cleanup screen — the dialog binds to what it showed', () => {
  async function openHero(): Promise<void> {
    await dom('[data-testid="hero-clean"]').trigger('click')
    await flushPromises()
  }
  const moved = (): GcSnapshot => {
    const s = snap()
    // the first ready item turned into a review item while the dialog was open
    const b = s.bundles.find((x) => x.bucket === 'ready')!
    b.bucket = 'review'
    b.reason = reviewReason('dirty')
    return s
  }

  it('a refresh that changes an item blocks the confirm until the dialog is reopened', async () => {
    const api = install(snap())
    await mountView()
    await openHero()
    expect(body('bulk-stale')).toBeNull()
    api.gcSnapshot.mockResolvedValue(moved())
    api.push.cycle({})
    await flushPromises()
    expect(body('bulk-stale')).not.toBeNull()
    expect((body('bulk-confirm') as HTMLButtonElement).disabled).toBe(true)
    ;(body('bulk-confirm') as HTMLButtonElement).click()
    await flushPromises()
    expect(api.gcClean).not.toHaveBeenCalled()
  })

  it('a refresh that changes nothing the dialog showed leaves it confirmable, with the facts it opened with', async () => {
    const api = install(snap())
    await mountView()
    await openHero()
    api.gcSnapshot.mockResolvedValue(snap()) // fresh objects, same facts
    api.push.cycle({})
    await flushPromises()
    expect(body('bulk-stale')).toBeNull()
    ;(body('bulk-confirm') as HTMLButtonElement).click()
    await flushPromises()
    const [ids, opts] = api.gcClean.mock.calls[0]
    expect(ids).toHaveLength(2)
    expect(Object.keys(opts.expected)).toEqual(ids)
  })

  it('reopening after the change shows the new facts and the confirm works again', async () => {
    const api = install(snap())
    await mountView()
    await openHero()
    api.gcSnapshot.mockResolvedValue(moved())
    api.push.cycle({})
    await flushPromises()
    ;(body('bulk-cancel') as HTMLButtonElement).click()
    await flushPromises()
    await openHero()
    expect(body('bulk-stale')).toBeNull()
    expect(document.body.querySelectorAll('[data-testid="bulk-row"]')).toHaveLength(1)
  })

  it('a rejected clean shows an error toast instead of failing silently', async () => {
    const api = install(snap())
    await mountView()
    const toast = vi.spyOn(useUiStore(), 'pushToast')
    api.gcClean.mockRejectedValueOnce(new Error('ipc exploded'))
    await openHero()
    ;(body('bulk-confirm') as HTMLButtonElement).click()
    await flushPromises()
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0][0]).toMatchObject({ kind: 'danger' })
    expect(toast.mock.calls[0][0].description).toContain('ipc exploded')
  })
})

describe('Cleanup screen — Keep on a selection', () => {
  const pick = async (names: string[]): Promise<void> => {
    for (const n of names) {
      const row = domAll('[data-testid="review-row"]').find((r) => r.text().includes(n))!
      await new Q(row.el!.querySelector('[data-testid="review-check"]')).setValue(true)
    }
  }

  it('skips orphan volumes: only worktree ids reach gc:keep', async () => {
    const api = install(snap())
    await mountView()
    await pick(['pg_old', 'd1'])
    await dom('[data-testid="sel-keep"]').trigger('click')
    expect(api.gcKeep).toHaveBeenCalledTimes(1)
    expect(String(api.gcKeep.mock.calls[0][0])).toContain('d1')
  })

  it('hides Keep when only orphan volumes are selected', async () => {
    install(snap())
    await mountView()
    await pick(['pg_old'])
    expect(dom('[data-testid="sel-keep"]').exists()).toBe(false)
  })

  it('a rejected keep shows a toast and refreshes the screen', async () => {
    const api = install(snap())
    await mountView()
    const toast = vi.spyOn(useUiStore(), 'pushToast')
    api.gcKeep.mockRejectedValueOnce(new Error('unknown cleanup item'))
    await pick(['d1'])
    const before = api.gcSnapshot.mock.calls.length
    await dom('[data-testid="sel-keep"]').trigger('click')
    expect(toast.mock.calls[0][0]).toMatchObject({ kind: 'danger' })
    expect(api.gcSnapshot.mock.calls.length).toBeGreaterThan(before)
  })
})

describe('Cleanup screen — the running line', () => {
  it('under the split bar the running job reads "Cleaning now · N left"', async () => {
    const api = install(snap())
    await mountView()
    api.push.progress({
      jobId: 'j1',
      done: 3,
      total: 12,
      freedBytes: 1,
      current: null,
      results: []
    })
    await flushPromises()
    expect(dom('[data-testid="split-running"]').text()).toBe('Cleaning now · 9 left')
  })
})

describe('Cleanup screen — toolbar and legend parity with the mockup', () => {
  it('the Map / List toggle carries its icons', async () => {
    install(snap())
    await mountView()
    const group = document.body.querySelector('[aria-label="Cleanup view"]')!
    const buttons = [...group.querySelectorAll('button')]
    expect(buttons.map((b) => b.textContent!.trim())).toEqual(['Map', 'List'])
    for (const b of buttons) expect(b.querySelector('svg')).not.toBeNull()
  })

  it('rescan is an icon-only button that still has a name and a tooltip', async () => {
    install(snap())
    await mountView()
    const btn = dom('[data-testid="cleanup-rescan"]')
    expect(btn.text()).toBe('')
    expect(btn.attributes('aria-label')).toBe('Scan now')
    expect(btn.attributes('title')).toBe('Scan now')
    expect(btn.el!.querySelector('svg')).not.toBeNull()
  })

  it('shows the legend row under the split bar, with the area note', async () => {
    install(snap())
    await mountView()
    expect(dom('[data-testid="legend"]').exists()).toBe(true)
    expect(dom('[data-testid="legend-area"]').text()).toContain('Block area = size on disk')
    const bar = document.body.querySelector('[data-testid="split-bar"]')!
    const legend = document.body.querySelector('[data-testid="legend"]')!
    expect(bar.compareDocumentPosition(legend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('Cleanup screen — Remove is honest: what main refuses is never offered', () => {
  // Main refuses a Remove for a detached worktree, a locked one, a shared stack, an open session…
  // The fake `gc:clean` here judges each id with main's own `refusalFor`, as `submitManualClean` does,
  // so a click that would have ended in "0 cleaned" fails the test instead of the operator.
  const detached = (name: string): ReturnType<typeof wt> =>
    wt(
      name,
      'review',
      GIB,
      { kind: 'detached-worktree', branch: null, id: `/w/repo::detached-worktree::${name}` },
      { reason: reviewReason('detached') }
    )
  const locked = (name: string): ReturnType<typeof wt> =>
    wt(name, 'review', GIB, {}, { reason: reviewReason('locked'), locked: true })
  const sharedStack = (name: string): ReturnType<typeof wt> =>
    wt(name, 'review', GIB, {}, { reason: reviewReason('shared-stack'), sharedStackIds: ['o'] })
  const sessionOpen = (name: string): ReturnType<typeof wt> =>
    wt(name, 'review', GIB, {}, { reason: reviewReason('open-idle-session'), session: 'open-idle' })
  const fine = (name: string): ReturnType<typeof wt> =>
    wt(name, 'review', 2 * GIB, {}, { reason: reviewReason('dirty') })

  function installJudged(s: GcSnapshot): Api {
    const api = install(s)
    api.gcClean.mockImplementation(async (ids: string[]) => {
      const results = ids.map((id) => {
        const b = s.bundles.find((x) => x.item.id === id)!
        const hard = refusalFor(b, s.prefs, { confirmed: true })
        return hard
          ? { id, ok: false, haltedAt: 'reprobe', error: hard, freedBytes: 0 }
          : { id, ok: true, haltedAt: null, freedBytes: 0 }
      })
      queueMicrotask(() =>
        api.push.done({
          jobId: 'j1',
          kind: 'manual',
          done: ids.length,
          total: ids.length,
          freedBytes: 0,
          results,
          error: null
        })
      )
      return { jobId: 'j1', queued: false }
    })
    return api
  }

  async function tickAll(): Promise<void> {
    for (const c of domAll('[data-testid="review-check"]')) await c.setValue(true)
  }
  async function removeSelected(): Promise<void> {
    await domGet('[data-testid="sel-remove"]').trigger('click')
    await flushPromises()
  }

  it('the selection bar disables Remove when nothing ticked can be removed, and says why', async () => {
    const api = installJudged(snapshotOf([detached('h1'), locked('l1')]))
    await mountView()
    await tickAll()
    const remove = domGet('[data-testid="sel-remove"]')
    expect(remove.attributes('disabled')).toBeDefined()
    await remove.trigger('click')
    expect(body('bulk-dialog')).toBeNull()
    expect(api.gcClean).not.toHaveBeenCalled()
    expect(remove.el!.parentElement!.getAttribute('title')).toBe(
      t('cleanup.gc.selection.removeNone')
    )
  })

  it('a mixed selection opens ONE dialog: what main takes counted and sent, the rest listed apart with why', async () => {
    const s = snapshotOf([
      detached('h1'),
      locked('l1'),
      sharedStack('s1'),
      sessionOpen('o1'),
      fine('d1')
    ])
    const api = installJudged(s)
    await mountView()
    await tickAll()
    await removeSelected()
    // counted: only the one that main takes
    expect(document.body.querySelectorAll('[data-testid="bulk-row"]')).toHaveLength(1)
    expect(body('bulk-confirm')!.textContent).toContain('1')
    // listed apart: each refused item, its reason, and the fix when there is a command
    const refused = domAll('[data-testid="bulk-refused-row"]')
    expect(refused).toHaveLength(4)
    expect(domGet('[data-testid="bulk-refused-title"]').text()).toBe(
      t('cleanup.gc.confirm.refusedTitle', { n: 4 })
    )
    const byRefusal = (r: string): Q =>
      new Q(document.body.querySelector(`[data-testid="bulk-refused-row"][data-refusal="${r}"]`))
    expect(byRefusal('locked').text()).toContain(t('cleanup.gc.removal.reason.locked'))
    expect(byRefusal('locked').text()).toContain('git worktree unlock /w/repo/.claude/worktrees/l1')
    expect(byRefusal('unsupported-kind').text()).toContain('git worktree remove')
    expect(byRefusal('shared-stack').text()).toContain(t('cleanup.gc.removal.reason.sharedStack'))
    expect(byRefusal('session-open').text()).toContain(t('cleanup.gc.removal.reason.sessionOpen'))
    ;(body('bulk-confirm') as HTMLButtonElement).click()
    await flushPromises()
    // not in the request
    const [ids, opts] = api.gcClean.mock.calls[0]
    expect(ids).toEqual(['/w/repo::worktree::d1'])
    expect(opts.confirmed).toEqual(['/w/repo::worktree::d1'])
    for (const id of ids as string[]) {
      const b = s.bundles.find((x) => x.item.id === id)!
      expect(refusalFor(b, s.prefs, { confirmed: true })).toBeNull()
    }
  })

  it('a dialog with nothing refused has no "Won\'t be removed" group', async () => {
    installJudged(snapshotOf([fine('d1'), fine('d2')]))
    await mountView()
    await tickAll()
    await removeSelected()
    expect(body('bulk-refused')).toBeNull()
  })

  it('when nothing is removable no dialog opens and a toast says why', async () => {
    installJudged(snapshotOf([locked('l1'), locked('l2')]))
    const w = await mountView()
    const toast = vi.spyOn(useUiStore(), 'pushToast')
    ;(w.vm as unknown as { openRemove(ids: string[]): void }).openRemove([
      '/w/repo::worktree::l1',
      '/w/repo::worktree::l2'
    ])
    await flushPromises()
    expect(body('bulk-dialog')).toBeNull()
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0][0]).toMatchObject({
      kind: 'warning',
      title: t('cleanup.gc.confirm.nothingRemovable'),
      description: t('cleanup.gc.removal.reason.locked')
    })
  })

  it('different reasons get the "each for its own reason" description', async () => {
    installJudged(snapshotOf([locked('l1'), detached('h1')]))
    const w = await mountView()
    const toast = vi.spyOn(useUiStore(), 'pushToast')
    ;(w.vm as unknown as { openRemove(ids: string[]): void }).openRemove([
      '/w/repo::worktree::l1',
      '/w/repo::detached-worktree::h1'
    ])
    await flushPromises()
    expect(toast.mock.calls[0][0]).toMatchObject({
      description: t('cleanup.gc.confirm.nothingRemovableSeveral')
    })
  })

  it('the list row shows no Remove button for an item main refuses, and the reason as its tooltip', async () => {
    installJudged(snapshotOf([locked('l1'), fine('d1')]))
    await mountView()
    expect(domAll('[data-testid="review-remove"]')).toHaveLength(1)
    const blocked = domGet('[data-testid="review-remove-blocked"]')
    expect(blocked.attributes('title')).toBe(t('cleanup.gc.removal.reason.locked'))
  })

  it('"Select all" in a repo ticks only the items main takes', async () => {
    installJudged(snapshotOf([locked('l1'), detached('h1'), fine('d1')]))
    const w = await mountView()
    ;(w.vm as unknown as { onSelectAllInRepo(repo: string): void }).onSelectAllInRepo('/w/repo')
    await flushPromises()
    const ticked = domAll('[data-testid="review-check"]').filter(
      (c) => (c.el as HTMLInputElement).checked
    )
    expect(ticked).toHaveLength(1)
    expect(domGet('[data-testid="sel-count"]').text()).toContain('1')
  })

  it('a demoted item shows its real reason in the list and a blocked Remove', async () => {
    const b = wt('x1', 'review', GIB, {}, { reason: reviewReason('cleanup-failed') })
    b.reprobeRefusal = { code: 'cannot-unregister', count: 2 }
    installJudged(snapshotOf([b]))
    await mountView()
    expect(domGet('[data-testid="review-reason"]').text()).toBe(
      t('cleanup.gc.removal.reason.cannotUnregister')
    )
    expect(dom('[data-testid="review-remove"]').exists()).toBe(false)
    expect(dom('[data-testid="review-remove-blocked"]').exists()).toBe(true)
  })

  it('the panel of a locked item offers no Remove and names the command', async () => {
    installJudged(snapshotOf([locked('l1')]))
    await mountView()
    await domGet('[data-testid="review-row"]').trigger('click')
    expect(dom('[data-testid="panel-remove"]').exists()).toBe(false)
    expect(domGet('[data-testid="panel-remove-hint"]').text()).toContain('git worktree unlock')
  })
})

describe('Cleanup screen — a ready item main refused leaves the hero', () => {
  it('the hero counts and sends only the items main did not refuse', async () => {
    const stuck = wt('c2', 'ready', 400 * MIB)
    stuck.reprobeRefusal = { code: 'cannot-unregister', count: 1 }
    const api = install(snapshotOf([wt('c1', 'ready', 500 * MIB), stuck]))
    await mountView()
    const hero = domGet('[data-testid="hero-clean"]')
    expect(hero.text()).toContain('1')
    await hero.trigger('click')
    await flushPromises()
    expect(document.body.querySelectorAll('[data-testid="bulk-row"]')).toHaveLength(1)
    ;(body('bulk-confirm') as HTMLButtonElement).click()
    await flushPromises()
    expect(api.gcClean.mock.calls[0][0]).toEqual(['/w/repo::worktree::c1'])
  })

  it('with only refused items left the hero is empty', async () => {
    const stuck = wt('c2', 'ready', 400 * MIB)
    stuck.reprobeRefusal = { code: 'tip-unknown', count: 1 }
    install(snapshotOf([stuck]))
    await mountView()
    expect(dom('[data-testid="hero-empty"]').exists()).toBe(true)
  })

  it('Retry from its panel tries it again on purpose', async () => {
    const stuck = wt('c2', 'ready', 400 * MIB)
    stuck.reprobeRefusal = { code: 'cannot-unregister', count: 1 }
    const api = install(snapshotOf([stuck]))
    await mountView()
    // the block is on the map; select it through the list view of the model
    const w = wrapper!
    ;(w.vm as unknown as { selectedId: string | null }).selectedId = '/w/repo::worktree::c2'
    await flushPromises()
    await domGet('[data-testid="panel-retry"]').trigger('click')
    await flushPromises()
    expect(body('bulk-dialog')).not.toBeNull()
    ;(body('bulk-confirm') as HTMLButtonElement).click()
    await flushPromises()
    expect(api.gcClean.mock.calls[0][0]).toEqual(['/w/repo::worktree::c2'])
  })
})

describe('Cleanup screen — scanned while Docker was down', () => {
  it('the hero is disabled and says to start Docker; no clean can be opened', async () => {
    const a = wt('c1', 'ready', 500 * MIB)
    a.dockerBlind = true
    const api = install(snapshotOf([a, { ...wt('c2', 'ready', 400 * MIB), dockerBlind: true }]))
    await mountView()
    const hero = domGet('[data-testid="hero-blind"]')
    expect(hero.attributes('disabled')).toBeDefined()
    expect(hero.text()).toContain(t('cleanup.gc.hero.blind'))
    await hero.trigger('click')
    expect(body('bulk-dialog')).toBeNull()
    expect(api.gcClean).not.toHaveBeenCalled()
    expect(dom('[data-testid="hero-clean"]').exists()).toBe(false)
  })
})

describe('Cleanup screen — Check again on a demoted item', () => {
  const demoted = (): ReturnType<typeof wt> => {
    const b = wt('x1', 'review', GIB, {}, { reason: reviewReason('cleanup-failed') })
    b.reprobeRefusal = { code: 'cannot-unregister', count: 2 }
    return b
  }
  const ID = '/w/repo::worktree::x1'

  async function openPanel(api: Api): Promise<void> {
    void api
    await mountView()
    await domGet('[data-testid="review-row"]').trigger('click')
  }

  it('asks main to recheck that one item and refreshes the snapshot; a fixed item says so', async () => {
    const api = install(snapshotOf([demoted()]))
    await openPanel(api)
    const before = api.gcSnapshot.mock.calls.length
    const toast = vi.spyOn(useUiStore(), 'pushToast')
    await domGet('[data-testid="panel-recheck"]').trigger('click')
    await flushPromises()
    expect(api.gcRecheck).toHaveBeenCalledWith(ID)
    expect(api.gcSnapshot.mock.calls.length).toBeGreaterThan(before)
    expect(toast.mock.calls[0][0]).toMatchObject({
      kind: 'success',
      title: t('cleanup.gc.recheck.cleared')
    })
  })

  it('a still-broken item stays demoted and the toast says why', async () => {
    const api = install(snapshotOf([demoted()]))
    api.gcRecheck.mockResolvedValue({ id: ID, outcome: 'still-refused', code: 'cannot-unregister' })
    await openPanel(api)
    const toast = vi.spyOn(useUiStore(), 'pushToast')
    await domGet('[data-testid="panel-recheck"]').trigger('click')
    await flushPromises()
    expect(toast.mock.calls[0][0]).toMatchObject({
      kind: 'warning',
      title: t('cleanup.gc.recheck.stillRefused'),
      description: t('cleanup.gc.removal.reason.cannotUnregister')
    })
    expect(dom('[data-testid="panel-recheck"]').exists()).toBe(true)
  })

  it('a check that could not answer says so instead of claiming a result', async () => {
    const api = install(snapshotOf([demoted()]))
    api.gcRecheck.mockResolvedValue({ id: ID, outcome: 'unchecked', code: 'docker-unavailable' })
    await openPanel(api)
    const toast = vi.spyOn(useUiStore(), 'pushToast')
    await domGet('[data-testid="panel-recheck"]').trigger('click')
    await flushPromises()
    expect(toast.mock.calls[0][0]).toMatchObject({
      kind: 'warning',
      title: t('cleanup.gc.recheck.unchecked')
    })
  })
})
