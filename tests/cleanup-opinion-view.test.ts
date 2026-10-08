// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import CleanupView from '../src/renderer/src/components/CleanupView.vue'
import { i18n } from '@renderer/i18n'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { GcOpinionDone, GcOpinionResult, GcSnapshot } from '../src/main/gc/gc-wire'
import { GIB, MIB, reviewReason, snapshotOf, volume, wt } from './helpers/cleanup-gc-fixtures'

/**
 * "Ask for an opinion" through the assembled Cleanup screen (T444 AC-6): what the buttons send, how
 * the chips arrive, and — above all — that "Remove the ones marked safe" only pre-selects and opens
 * the existing confirm, which is the only thing that reaches `gc:clean`.
 */

const t = (key: string, named?: Record<string, unknown>): string =>
  (named ? i18n.global.t(key, named) : i18n.global.t(key)) as string

const D1 = '/w/repo::worktree::d1'
const D2 = '/w/repo::worktree::d2'
const D3 = '/w/repo::worktree::d3'
const VOL = 'volume:pg_old'

function snap(tip = 'a'.repeat(40)): GcSnapshot {
  return {
    ...snapshotOf(
      [
        wt('c1', 'ready', 500 * MIB),
        wt('d1', 'review', 3 * GIB, {}, { reason: reviewReason('dirty'), localTip: tip }),
        wt('d2', 'review', 2 * GIB, {}, { reason: reviewReason('closed-unmerged') }),
        wt('d3', 'review', 1 * GIB, {}, { reason: reviewReason('remote-gone') }),
        wt('a1', 'in-use', 1 * GIB)
      ],
      [volume('pg_old', 'old-app', 300 * MIB)]
    ),
    prefs: { ...defaultGcPrefs(), autopilot: true, firstReportAcknowledged: true }
  }
}

interface Rig {
  gcOpinion: ReturnType<typeof vi.fn>
  gcClean: ReturnType<typeof vi.fn>
  gcSnapshot: ReturnType<typeof vi.fn>
  result(r: Omit<GcOpinionResult, 'jobId'> & { jobId?: string }): Promise<void>
  done(d: Partial<GcOpinionDone>): Promise<void>
}

function install(first: GcSnapshot): Rig {
  const handlers: {
    result?: (r: GcOpinionResult) => void
    done?: (d: GcOpinionDone) => void
  } = {}
  const rig = {
    gcOpinion: vi.fn(async () => ({ jobId: 'job-1' })),
    gcClean: vi.fn(async () => ({ jobId: 'j1', queued: false })),
    gcSnapshot: vi.fn(async () => first)
  }
  const full = {
    ...rig,
    gcKeep: vi.fn(async () => defaultGcPrefs()),
    gcJobs: vi.fn(async () => []),
    gcPrefs: vi.fn(async () => first.prefs),
    onGcOpinionResult: vi.fn((cb: (r: GcOpinionResult) => void) => {
      handlers.result = cb
      return () => {}
    }),
    onGcOpinionDone: vi.fn((cb: (d: GcOpinionDone) => void) => {
      handlers.done = cb
      return () => {}
    }),
    reaperSnapshot: vi.fn(async () => ({ scannedAt: Date.now(), repos: [] })),
    reaperScan: vi.fn(async () => ({ scannedAt: Date.now(), repos: [] })),
    reaperJournal: vi.fn(async () => []),
    reaperPrefs: vi.fn(async () => ({ dehydrateIdleDays: 7 }))
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(full, {
    get: (t2: Record<string, unknown>, k: string) => (k in t2 ? t2[k] : () => () => {})
  })
  return {
    ...rig,
    async result(r) {
      handlers.result?.({ jobId: 'job-1', ...r } as GcOpinionResult)
      await flushPromises()
    },
    async done(d) {
      handlers.done?.({ jobId: 'job-1', answered: 0, cached: 0, refused: 0, failed: 0, ...d })
      await flushPromises()
    }
  }
}

let wrapper: VueWrapper | null = null

async function mountView(): Promise<VueWrapper> {
  const slot = document.createElement('span')
  slot.id = 'takeover-shell-icon'
  document.body.appendChild(slot)
  wrapper = mount(CleanupView, { global: { plugins: [i18n] }, attachTo: document.body })
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

const q = (sel: string): Element | null => document.body.querySelector(sel)
const qa = (sel: string): Element[] => Array.from(document.body.querySelectorAll(sel))
const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
async function click(el: Element | null, init: MouseEventInit = {}): Promise<void> {
  if (!el) throw new Error('nothing to click')
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  await flushPromises()
}
async function check(id: string): Promise<void> {
  const row = qa('[data-testid="review-row"]').find((r) => r.getAttribute('data-id') === id)!
  const box = row.querySelector('[data-testid="review-check"]') as HTMLInputElement
  box.checked = true
  box.dispatchEvent(new Event('change', { bubbles: true }))
  await flushPromises()
}
const rowOf = (id: string): Element =>
  qa('[data-testid="review-row"]').find((r) => r.getAttribute('data-id') === id)!
const chipOf = (id: string): Element | null =>
  rowOf(id).querySelector('[data-testid="opinion-chip"]')
const safe = (id: string): Omit<GcOpinionResult, 'jobId'> => ({
  id,
  verdict: 'safe',
  reason: 'Everything it changed is on main.',
  evidence: 'the changed files are on main at abc123'
})

describe('asking from the selection bar', () => {
  it('sends only the checked ids, shows Asking… on them, and nothing on the others', async () => {
    const rig = install(snap())
    await mountView()
    await check(D1)
    await check(D2)
    await click(q('[data-testid="sel-ask"]'))
    expect(rig.gcOpinion).toHaveBeenCalledTimes(1)
    expect([...rig.gcOpinion.mock.calls[0][0]].sort()).toEqual([D1, D2].sort())
    expect(chipOf(D1)?.getAttribute('data-state')).toBe('pending')
    expect(chipOf(D2)?.getAttribute('data-state')).toBe('pending')
    expect(chipOf(D3)).toBeNull()
    expect(rig.gcClean).not.toHaveBeenCalled()
  })

  it('turns each pending chip into its verdict as the results stream in', async () => {
    const rig = install(snap())
    await mountView()
    await check(D1)
    await check(D2)
    await click(q('[data-testid="sel-ask"]'))
    await rig.result(safe(D1))
    expect(chipOf(D1)?.getAttribute('data-state')).toBe('safe')
    expect(chipOf(D2)?.getAttribute('data-state')).toBe('pending')
    await rig.result({ id: D2, verdict: 'keep', reason: 'Two commits.', evidence: '2 unpushed' })
    await rig.done({ answered: 2 })
    expect(chipOf(D2)?.getAttribute('data-state')).toBe('keep')
    expect(text(chipOf(D1))).toBe(t('cleanup.gc.opinion.safe'))
    expect(chipOf(D1)?.getAttribute('title')).toContain('Everything it changed is on main.')
    expect(chipOf(D1)?.getAttribute('title')).toContain('the changed files are on main at abc123')
  })

  it('does not ask twice for an item whose answer is still on its way', async () => {
    const rig = install(snap())
    await mountView()
    await check(D1)
    await click(q('[data-testid="sel-ask"]'))
    await click(q('[data-testid="sel-ask"]'))
    expect(rig.gcOpinion).toHaveBeenCalledTimes(1)
  })

  it('a refused id ends its pending state without drawing a chip', async () => {
    const rig = install(snap())
    await mountView()
    await check(D1)
    await click(q('[data-testid="sel-ask"]'))
    await rig.result({ id: D1, refused: 'not-review' })
    expect(chipOf(D1)).toBeNull()
  })

  it('a rejected request clears the pending state and says so', async () => {
    const rig = install(snap())
    rig.gcOpinion.mockRejectedValueOnce(new Error('gc:opinion takes at most 100 ids'))
    await mountView()
    await check(D1)
    await click(q('[data-testid="sel-ask"]'))
    expect(chipOf(D1)).toBeNull()
    const toasts = useUiStore().toasts
    expect(toasts.some((x) => x.title === t('cleanup.gc.opinion.failed'))).toBe(true)
  })

  it('a lost result does not leave Asking… behind once the job is done', async () => {
    const rig = install(snap())
    await mountView()
    await check(D1)
    await click(q('[data-testid="sel-ask"]'))
    await rig.done({ failed: 1 })
    expect(chipOf(D1)).toBeNull()
  })
})

describe('asking about all, and from the panel', () => {
  it('"Ask on all" sends every Needs review id, orphan volumes included, and never a ready or in-use one', async () => {
    const rig = install(snap())
    await mountView()
    await click(q('[data-testid="review-ask-all"]'))
    expect([...rig.gcOpinion.mock.calls[0][0]].sort()).toEqual([D1, D2, D3, VOL].sort())
  })

  it('the panel button asks about that one item and the panel then shows reason and evidence', async () => {
    const rig = install(snap())
    await mountView()
    await click(rowOf(D1))
    await click(q('[data-testid="panel-ask"]'))
    expect(rig.gcOpinion.mock.calls[0][0]).toEqual([D1])
    expect(q('[data-testid="panel-ask"]')?.hasAttribute('disabled')).toBe(true)
    await rig.result(safe(D1))
    expect(text(q('[data-testid="panel-opinion-reason"]'))).toBe(
      'Everything it changed is on main.'
    )
    expect(text(q('[data-testid="panel-opinion-evidence"]'))).toContain(
      'the changed files are on main at abc123'
    )
  })
})

describe('"Remove the ones marked safe"', () => {
  async function askedAll(rig: Rig): Promise<void> {
    await click(q('[data-testid="review-ask-all"]'))
    await rig.result(safe(D1))
    await rig.result({ id: D2, verdict: 'keep', reason: 'Two commits.', evidence: '2 unpushed' })
    await rig.result(safe(D3))
    await rig.result({ id: VOL, verdict: 'unsure', reason: 'No idea.', evidence: 'none' })
    await rig.done({ answered: 4 })
  }

  it('is hidden until something is marked safe, then counts the safe ones', async () => {
    const rig = install(snap())
    await mountView()
    expect(q('[data-testid="review-remove-safe"]')).toBeNull()
    await click(q('[data-testid="review-ask-all"]'))
    await rig.result({ id: D1, verdict: 'keep', reason: 'r', evidence: 'e' })
    expect(q('[data-testid="review-remove-safe"]')).toBeNull()
    await rig.result(safe(D3))
    expect(text(q('[data-testid="review-remove-safe"]'))).toBe(
      t('cleanup.gc.review.removeSafe', { count: 1 })
    )
  })

  it('pre-selects exactly the safe items and opens the remove dialog; it removes nothing by itself', async () => {
    const rig = install(snap())
    await mountView()
    await askedAll(rig)
    await click(q('[data-testid="review-remove-safe"]'))
    expect(q('[data-testid="sel-count"]')?.textContent).toContain('2')
    expect(
      qa('[data-testid="review-check"]').filter((c) => (c as HTMLInputElement).checked)
    ).toHaveLength(2)
    // The existing remove dialog, in Needs review mode, listing just the two safe items.
    expect(q('[data-testid="bulk-warning"]')).not.toBeNull()
    expect(qa('[data-testid="bulk-row"]')).toHaveLength(2)
    expect(rig.gcClean).not.toHaveBeenCalled()
  })

  it('shows each row’s chip and evidence in the dialog', async () => {
    const rig = install(snap())
    await mountView()
    await askedAll(rig)
    await click(q('[data-testid="review-remove-safe"]'))
    const evidence = qa('[data-testid="opinion-evidence"]')
    expect(evidence).toHaveLength(2)
    expect(evidence.every((e) => text(e).includes('on main at abc123'))).toBe(true)
  })

  it('confirming sends each id as confirmed with its expected facts — the S5 contract, unchanged', async () => {
    const rig = install(snap())
    await mountView()
    await askedAll(rig)
    await click(q('[data-testid="review-remove-safe"]'))
    await click(q('[data-testid="bulk-confirm"]'))
    expect(rig.gcClean).toHaveBeenCalledTimes(1)
    const [ids, opts] = rig.gcClean.mock.calls[0]
    expect([...ids].sort()).toEqual([D1, D3].sort())
    expect([...opts.confirmed].sort()).toEqual([D1, D3].sort())
    expect(Object.keys(opts.expected).sort()).toEqual([D1, D3].sort())
    expect(opts.expected[D1]).toMatchObject({ bucket: 'review', reasonCode: 'dirty' })
  })

  it('cancelling the dialog removes nothing', async () => {
    const rig = install(snap())
    await mountView()
    await askedAll(rig)
    await click(q('[data-testid="review-remove-safe"]'))
    await click(q('[data-testid="bulk-cancel"]'))
    expect(rig.gcClean).not.toHaveBeenCalled()
  })

  it('drops a verdict once the item changed, so a stale safe cannot be removed', async () => {
    const rig = install(snap())
    await mountView()
    await askedAll(rig)
    expect(q('[data-testid="review-remove-safe"]')).not.toBeNull()
    // The next snapshot shows d1 on a different commit.
    rig.gcSnapshot.mockResolvedValue(snap('b'.repeat(40)))
    await click(q('[data-testid="cleanup-rescan"]'))
    await flushPromises()
    expect(chipOf(D1)).toBeNull()
    expect(chipOf(D3)?.getAttribute('data-state')).toBe('safe')
    expect(text(q('[data-testid="review-remove-safe"]'))).toBe(
      t('cleanup.gc.review.removeSafe', { count: 1 })
    )
  })
})
