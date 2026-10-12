// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CleanupReviewList from '../src/renderer/src/components/CleanupReviewList.vue'
import { i18n } from '@renderer/i18n'
import type { GcBlock } from '../src/renderer/src/lib/gc-model'
import type { HydrationInfo } from '../src/main/reaper/reaper-core'
import { formatBytes } from '../src/renderer/src/components/system-monitor-format'
import { MIB, modelOf, reviewReason, wt } from './helpers/cleanup-gc-fixtures'

/**
 * AC-D4 (unit D), the visible half: a dehydrated worktree that sits in Needs review says so and
 * says how much is still on disk ("Dehydrated · 6 MB left"), and still offers Remove through the
 * normal guarded path. It never sits there as an unexplained row.
 */

const skeleton: HydrationInfo = {
  state: 'dehydrated',
  removable: [],
  skipped: [],
  reclaimableBytes: null,
  canRehydrate: true,
  rehydrateChanged: []
}

function mountList(blocks: GcBlock[]) {
  return mount(CleanupReviewList, {
    props: {
      blocks,
      checked: new Set<string>(),
      linkedId: null,
      blockState: () => null,
      failureOf: () => null,
      opinionOf: () => null,
      isAsking: () => false,
      safeCount: 0
    },
    global: { plugins: [i18n] }
  })
}

const t = (key: string, named?: Record<string, unknown>): string =>
  (named ? i18n.global.t(key, named) : i18n.global.t(key)) as string

describe('a dehydrated worktree in Needs review (AC-D4)', () => {
  const dirtySkeleton = () =>
    modelOf([
      wt(
        'skel',
        'review',
        6 * MIB,
        { hydration: skeleton },
        { reason: reviewReason('closed-unmerged') }
      ),
      wt('full', 'review', 900 * MIB, {}, { reason: reviewReason('closed-unmerged') })
    ])

  it('shows "Dehydrated · X left" on its row, and only on that row', () => {
    const m = dirtySkeleton()
    const w = mountList(m.review)
    const rows = w.findAll('[data-testid="review-row"]')
    const skel = rows.find((r) => r.attributes('data-id')!.endsWith('skel'))!
    const full = rows.find((r) => r.attributes('data-id')!.endsWith('full'))!
    expect(skel.get('[data-testid="review-dehydrated"]').text()).toBe(
      t('cleanup.gc.review.dehydratedLeft', { size: formatBytes(6 * MIB) })
    )
    expect(full.find('[data-testid="review-dehydrated"]').exists()).toBe(false)
  })

  it('still offers Remove (the normal guarded path) and no second Dehydrate', () => {
    const w = mountList(dirtySkeleton().review)
    const skel = w
      .findAll('[data-testid="review-row"]')
      .find((r) => r.attributes('data-id')!.endsWith('skel'))!
    expect(skel.find('[data-testid="review-remove"]').exists()).toBe(true)
    expect(skel.find('[data-testid="review-dehydrate"]').exists()).toBe(false)
  })

  it('the view-model carries the hydration state and the bytes left on disk', () => {
    const b = dirtySkeleton().blocks.find((x) => x.name === 'skel')!
    expect(b.hydration).toEqual({ state: 'dehydrated', bytesLeft: 6 * MIB })
  })
})
