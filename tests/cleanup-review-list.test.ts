// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CleanupReviewList from '../src/renderer/src/components/CleanupReviewList.vue'
import CleanupListView from '../src/renderer/src/components/CleanupListView.vue'
import { i18n } from '@renderer/i18n'
import type { BlockJobState, ItemFailure } from '../src/renderer/src/lib/gc-jobs'
import type { GcOpinion } from '../src/main/gc/gc-wire'
import type { GcBlock } from '../src/renderer/src/lib/gc-model'
import { GIB, MIB, reviewReason, modelOf, volume, wt } from './helpers/cleanup-gc-fixtures'

const t = (key: string, named?: Record<string, unknown>): string =>
  (named ? i18n.global.t(key, named) : i18n.global.t(key)) as string

interface Opts {
  checked?: string[]
  linkedId?: string | null
  blockState?: (id: string) => BlockJobState | null
  failureOf?: (id: string) => ItemFailure | null
  opinions?: Record<string, GcOpinion>
  asking?: string[]
  safeCount?: number
}

function mountList(blocks: GcBlock[], o: Opts = {}) {
  return mount(CleanupReviewList, {
    props: {
      blocks,
      checked: new Set(o.checked ?? []),
      linkedId: o.linkedId ?? null,
      blockState: o.blockState ?? (() => null),
      failureOf: o.failureOf ?? (() => null),
      opinionOf: (id: string) => o.opinions?.[id] ?? null,
      isAsking: (id: string) => (o.asking ?? []).includes(id),
      safeCount: o.safeCount ?? 0
    },
    global: { plugins: [i18n] }
  })
}

const reviewModel = () =>
  modelOf(
    [
      wt('d1', 'review', 2 * GIB, {}, { reason: reviewReason('dirty') }),
      wt('d2', 'review', 600 * MIB, {}, { reason: reviewReason('closed-unmerged') })
    ],
    [volume('pg_data', 'old-app', 900 * MIB)]
  )

const rows = (w: ReturnType<typeof mountList>) => w.findAll('[data-testid="review-row"]')

describe('CleanupReviewList', () => {
  it('lists Needs review items biggest first with their translated reason and size', () => {
    const m = reviewModel()
    const w = mountList(m.review)
    expect(rows(w)).toHaveLength(3)
    expect(rows(w).map((r) => r.attributes('data-id'))).toEqual(m.review.map((b) => b.id))
    expect(w.get('[data-testid="review-count"]').text()).toBe('3')
    expect(rows(w)[0].get('[data-testid="review-reason"]').text()).toBe(
      t('cleanup.gc.reason.dirty')
    )
    expect(rows(w)[0].text()).toContain('2.15 GB')
  })

  it('an orphan volume row shows its project and "no known worktree", without Keep', () => {
    const w = mountList(reviewModel().review)
    const vol = rows(w).find((r) => r.attributes('data-id') === 'volume:pg_data')!
    expect(vol.get('[data-testid="review-sub"]').text()).toBe(
      t('cleanup.gc.review.volumeProject', { project: 'old-app' })
    )
    expect(vol.get('[data-testid="review-reason"]').text()).toBe(
      t('cleanup.gc.reason.noKnownWorktree')
    )
    expect(vol.find('[data-testid="review-keep"]').exists()).toBe(false)
    expect(vol.find('[data-testid="review-remove"]').exists()).toBe(true)
  })

  it('the hover-reveal checkbox toggles; a plain row click opens the block', async () => {
    const m = reviewModel()
    const w = mountList(m.review)
    await rows(w)[0].get('[data-testid="review-check"]').setValue(true)
    expect(w.emitted('toggle')).toEqual([[m.review[0].id]])
    expect(w.emitted('select')).toBeUndefined() // the checkbox click does not also open the row
    await rows(w)[1].trigger('click')
    expect(w.emitted('select')).toEqual([[m.review[1].id]])
  })

  it('a checked row shows the checked treatment and a ticked box', () => {
    const m = reviewModel()
    const w = mountList(m.review, { checked: [m.review[0].id] })
    expect(rows(w)[0].classes()).toContain('bg-accent-soft')
    expect(
      (rows(w)[0].get('[data-testid="review-check"]').element as HTMLInputElement).checked
    ).toBe(true)
    expect(rows(w)[1].classes()).not.toContain('bg-accent-soft')
  })

  it('hovering a row tells the screen which block to outline', async () => {
    const m = reviewModel()
    const w = mountList(m.review)
    await rows(w)[1].trigger('mouseenter')
    await rows(w)[1].trigger('mouseleave')
    expect(w.emitted('hover')).toEqual([[m.review[1].id], [null]])
  })

  it('row actions emit their id', async () => {
    const m = modelOf([
      wt(
        'd1',
        'review',
        GIB,
        {
          hydration: {
            state: 'hydrated',
            removable: ['node_modules'],
            skipped: [],
            reclaimableBytes: 1,
            canRehydrate: true,
            rehydrateChanged: []
          }
        },
        { reason: reviewReason('dirty') }
      )
    ])
    const w = mountList(m.review)
    await w.get('[data-testid="review-remove"]').trigger('click')
    await w.get('[data-testid="review-keep"]').trigger('click')
    await w.get('[data-testid="review-dehydrate"]').trigger('click')
    const id = m.review[0].id
    expect(w.emitted('remove')).toEqual([[id]])
    expect(w.emitted('keep')).toEqual([[id]])
    expect(w.emitted('dehydrate')).toEqual([[id]])
    expect(w.emitted('select')).toBeUndefined() // action buttons do not open the row
  })

  it('"Ask for an opinion on all N" is enabled and emits askAll', async () => {
    const w = mountList(reviewModel().review)
    const ask = w.get('[data-testid="review-ask-all"]')
    expect(ask.attributes('disabled')).toBeUndefined()
    expect(ask.element.parentElement?.getAttribute('title')).toBe(t('cleanup.gc.opinion.hint'))
    expect(ask.text()).toBe(t('cleanup.gc.review.askAll', { count: 3 }))
    await ask.trigger('click')
    expect(w.emitted('askAll')).toHaveLength(1)
  })

  it('disables "Ask on all" only while every item is already being asked about', () => {
    const m = reviewModel()
    const some = mountList(m.review, { asking: [m.review[0].id] })
    expect(some.get('[data-testid="review-ask-all"]').attributes('disabled')).toBeUndefined()
    const all = mountList(m.review, { asking: m.review.map((b) => b.id) })
    expect(all.get('[data-testid="review-ask-all"]').attributes('disabled')).toBeDefined()
  })

  it('"Remove the N marked safe" is hidden without safe opinions and emits removeSafe otherwise', async () => {
    const m = reviewModel()
    expect(mountList(m.review).find('[data-testid="review-remove-safe"]').exists()).toBe(false)
    const w = mountList(m.review, { safeCount: 2 })
    const btn = w.get('[data-testid="review-remove-safe"]')
    expect(btn.text()).toBe('Remove the 2 marked safe')
    await btn.trigger('click')
    expect(w.emitted('removeSafe')).toHaveLength(1)
    // It only asks the screen to pre-select: the list itself never emits a removal for it.
    expect(w.emitted('remove')).toBeUndefined()
  })

  it('draws a chip per verdict under the reason, a pending chip while asking, and none otherwise', () => {
    const m = reviewModel()
    const [a, b, c] = m.review
    const w = mountList(m.review, {
      opinions: {
        [a.id]: { id: a.id, verdict: 'safe', reason: 'r', evidence: 'e' },
        [b.id]: { id: b.id, verdict: 'keep', reason: 'r', evidence: 'e' }
      },
      asking: [c.id]
    })
    const chip = (id: string) =>
      rows(w)
        .find((r) => r.attributes('data-id') === id)!
        .find('[data-testid="opinion-chip"]')
    expect(chip(a.id).attributes('data-state')).toBe('safe')
    expect(chip(b.id).attributes('data-state')).toBe('keep')
    expect(chip(c.id).attributes('data-state')).toBe('pending')
    const bare = mountList(m.review)
    expect(bare.find('[data-testid="opinion-chip"]').exists()).toBe(false)
  })

  it('a failed row is flagged, and a changed-since-confirm refusal says to review again', () => {
    const m = reviewModel()
    const id = m.review[1].id
    const w = mountList(m.review, {
      blockState: (x) => (x === id ? 'failed' : null),
      failureOf: (x) =>
        x === id
          ? { step: 'reprobe', error: 'changed-since-confirm', refusal: 'changed-since-confirm' }
          : null
    })
    const row = rows(w)[1]
    expect(row.classes()).toContain('bg-red-soft')
    expect(row.find('.lucide-triangle-alert').exists()).toBe(true)
    expect(row.get('[data-testid="review-reason"]').text()).toBe(
      t('cleanup.gc.refusal.changedSinceConfirm')
    )
  })

  it('renders only the first 50 rows until asked for all (64+ worktrees stay fast)', async () => {
    const many = modelOf(
      Array.from({ length: 64 }, (_, i) =>
        wt(
          `w${String(i).padStart(2, '0')}`,
          'review',
          (100 + i) * MIB,
          {},
          { reason: reviewReason('dirty') }
        )
      )
    )
    const w = mountList(many.review)
    expect(rows(w)).toHaveLength(50)
    expect(w.get('[data-testid="review-show-all"]').text()).toBe(
      t('cleanup.gc.review.showAll', { count: 64 })
    )
    await w.get('[data-testid="review-show-all"]').trigger('click')
    expect(rows(w)).toHaveLength(64)
    expect(w.find('[data-testid="review-show-all"]').exists()).toBe(false)
  })

  it('has no cap button at 50 or fewer', () => {
    const w = mountList(reviewModel().review)
    expect(w.find('[data-testid="review-show-all"]').exists()).toBe(false)
  })

  it('an empty list says nothing needs the operator', () => {
    const w = mountList([])
    expect(rows(w)).toHaveLength(0)
    expect(w.text()).toContain(t('cleanup.gc.review.empty'))
  })
})

describe('CleanupListView (the List fallback)', () => {
  const model = () =>
    modelOf(
      [
        wt('c1', 'ready', 2 * GIB),
        wt('d1', 'review', 1 * GIB, {}, { reason: reviewReason('dirty') }),
        wt('a1', 'in-use', 500 * MIB)
      ],
      [volume('pg_data', 'old-app', 300 * MIB)]
    )

  it('groups by bucket, the Needs review group including orphan volumes', () => {
    const w = mount(CleanupListView, {
      props: { model: model(), blockState: () => null },
      global: { plugins: [i18n] }
    })
    for (const b of ['ready', 'review', 'in-use']) {
      expect(w.find(`[data-testid="list-group-${b}"]`).exists()).toBe(true)
    }
    expect(w.findAll('[data-testid="list-group-review"] [data-testid="list-row"]')).toHaveLength(2)
  })

  it('draws each bar relative to the biggest in its group', () => {
    const w = mount(CleanupListView, {
      props: { model: model(), blockState: () => null },
      global: { plugins: [i18n] }
    })
    const bars = w.findAll('[data-testid="list-group-review"] [data-testid="list-bar"]')
    expect(bars[0].attributes('style')).toContain('100%')
    expect(bars[1].attributes('style')).toContain('29.29')
  })

  it('opens a row, shows "—" for an unmeasured size, and disables a freed row', async () => {
    const m = modelOf([wt('c1', 'ready', null), wt('c2', 'ready', GIB)])
    const done = m.blocks.find((b) => b.name === 'c2')!.id
    const w = mount(CleanupListView, {
      props: { model: m, blockState: (id: string) => (id === done ? 'done' : null) },
      global: { plugins: [i18n] }
    })
    const r = w.findAll('[data-testid="list-row"]')
    const unmeasured = r.find((x) => x.text().includes('c1'))!
    expect(unmeasured.text()).toContain('—')
    await unmeasured.trigger('click')
    expect(w.emitted('select')).toEqual([[m.blocks.find((b) => b.name === 'c1')!.id]])
    expect(r.find((x) => x.text().includes('c2'))!.attributes('disabled')).toBeDefined()
  })
})
