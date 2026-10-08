// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CleanupNeedsYouList from '../src/renderer/src/components/CleanupNeedsYouList.vue'
import CleanupListView from '../src/renderer/src/components/CleanupListView.vue'
import { i18n } from '@renderer/i18n'
import type { BlockJobState, ItemFailure } from '../src/renderer/src/lib/gc-jobs'
import type { GcBlock } from '../src/renderer/src/lib/gc-model'
import { GIB, MIB, reviewReason, modelOf, volume, wt } from './helpers/cleanup-gc-fixtures'

const t = (key: string, named?: Record<string, unknown>): string =>
  (named ? i18n.global.t(key, named) : i18n.global.t(key)) as string

interface Opts {
  checked?: string[]
  linkedId?: string | null
  blockState?: (id: string) => BlockJobState | null
  failureOf?: (id: string) => ItemFailure | null
}

function mountList(blocks: GcBlock[], o: Opts = {}) {
  return mount(CleanupNeedsYouList, {
    props: {
      blocks,
      checked: new Set(o.checked ?? []),
      linkedId: o.linkedId ?? null,
      blockState: o.blockState ?? (() => null),
      failureOf: o.failureOf ?? (() => null)
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

const rows = (w: ReturnType<typeof mountList>) => w.findAll('[data-testid="needs-you-row"]')

describe('CleanupNeedsYouList', () => {
  it('lists Needs review items biggest first with their translated reason and size', () => {
    const m = reviewModel()
    const w = mountList(m.needsYou)
    expect(rows(w)).toHaveLength(3)
    expect(rows(w).map((r) => r.attributes('data-id'))).toEqual(m.needsYou.map((b) => b.id))
    expect(w.get('[data-testid="needs-you-count"]').text()).toBe('3')
    expect(rows(w)[0].get('[data-testid="needs-you-reason"]').text()).toBe(
      t('cleanup.gc.reason.dirty')
    )
    expect(rows(w)[0].text()).toContain('2.15 GB')
  })

  it('an orphan volume row shows its project and "no known worktree", without Keep', () => {
    const w = mountList(reviewModel().needsYou)
    const vol = rows(w).find((r) => r.attributes('data-id') === 'volume:pg_data')!
    expect(vol.get('[data-testid="needs-you-sub"]').text()).toBe(
      t('cleanup.gc.needsYou.volumeProject', { project: 'old-app' })
    )
    expect(vol.get('[data-testid="needs-you-reason"]').text()).toBe(
      t('cleanup.gc.reason.noKnownWorktree')
    )
    expect(vol.find('[data-testid="needs-you-keep"]').exists()).toBe(false)
    expect(vol.find('[data-testid="needs-you-remove"]').exists()).toBe(true)
  })

  it('the hover-reveal checkbox toggles; a plain row click opens the block', async () => {
    const m = reviewModel()
    const w = mountList(m.needsYou)
    await rows(w)[0].get('[data-testid="needs-you-check"]').setValue(true)
    expect(w.emitted('toggle')).toEqual([[m.needsYou[0].id]])
    expect(w.emitted('select')).toBeUndefined() // the checkbox click does not also open the row
    await rows(w)[1].trigger('click')
    expect(w.emitted('select')).toEqual([[m.needsYou[1].id]])
  })

  it('a checked row shows the checked treatment and a ticked box', () => {
    const m = reviewModel()
    const w = mountList(m.needsYou, { checked: [m.needsYou[0].id] })
    expect(rows(w)[0].classes()).toContain('bg-accent-soft')
    expect(
      (rows(w)[0].get('[data-testid="needs-you-check"]').element as HTMLInputElement).checked
    ).toBe(true)
    expect(rows(w)[1].classes()).not.toContain('bg-accent-soft')
  })

  it('hovering a row tells the screen which block to outline', async () => {
    const m = reviewModel()
    const w = mountList(m.needsYou)
    await rows(w)[1].trigger('mouseenter')
    await rows(w)[1].trigger('mouseleave')
    expect(w.emitted('hover')).toEqual([[m.needsYou[1].id], [null]])
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
    const w = mountList(m.needsYou)
    await w.get('[data-testid="needs-you-remove"]').trigger('click')
    await w.get('[data-testid="needs-you-keep"]').trigger('click')
    await w.get('[data-testid="needs-you-dehydrate"]').trigger('click')
    const id = m.needsYou[0].id
    expect(w.emitted('remove')).toEqual([[id]])
    expect(w.emitted('keep')).toEqual([[id]])
    expect(w.emitted('dehydrate')).toEqual([[id]])
    expect(w.emitted('select')).toBeUndefined() // action buttons do not open the row
  })

  it('"Ask for an opinion on all N" is visible, disabled, and says it is coming', () => {
    const w = mountList(reviewModel().needsYou)
    const ask = w.get('[data-testid="needs-you-ask-all"]')
    expect(ask.attributes('disabled')).toBeDefined()
    expect(ask.attributes('title')).toBe(t('cleanup.gc.needsYou.askSoon'))
    expect(ask.text()).toBe(t('cleanup.gc.needsYou.askAll', { count: 3 }))
  })

  it('a failed row is flagged, and a changed-since-confirm refusal says to review again', () => {
    const m = reviewModel()
    const id = m.needsYou[1].id
    const w = mountList(m.needsYou, {
      blockState: (x) => (x === id ? 'failed' : null),
      failureOf: (x) =>
        x === id
          ? { step: 'reprobe', error: 'changed-since-confirm', refusal: 'changed-since-confirm' }
          : null
    })
    const row = rows(w)[1]
    expect(row.classes()).toContain('bg-red-soft')
    expect(row.find('.lucide-triangle-alert').exists()).toBe(true)
    expect(row.get('[data-testid="needs-you-reason"]').text()).toBe(
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
    const w = mountList(many.needsYou)
    expect(rows(w)).toHaveLength(50)
    expect(w.get('[data-testid="needs-you-show-all"]').text()).toBe(
      t('cleanup.gc.needsYou.showAll', { count: 64 })
    )
    await w.get('[data-testid="needs-you-show-all"]').trigger('click')
    expect(rows(w)).toHaveLength(64)
    expect(w.find('[data-testid="needs-you-show-all"]').exists()).toBe(false)
  })

  it('has no cap button at 50 or fewer', () => {
    const w = mountList(reviewModel().needsYou)
    expect(w.find('[data-testid="needs-you-show-all"]').exists()).toBe(false)
  })

  it('an empty list says nothing needs the operator', () => {
    const w = mountList([])
    expect(rows(w)).toHaveLength(0)
    expect(w.text()).toContain(t('cleanup.gc.needsYou.empty'))
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
