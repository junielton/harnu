// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import CleanupBlockPanel from '../src/renderer/src/components/CleanupBlockPanel.vue'
import { i18n } from '@renderer/i18n'
import type { Bucket } from '../src/main/gc/bundle-core'
import type { ReapItem, HydrationInfo } from '../src/preload'
import type { GcBlock } from '../src/renderer/src/lib/gc-model'
import type { BlockJobState, ItemFailure } from '../src/renderer/src/lib/gc-jobs'
import { CHANGED_SINCE_CONFIRM, REFUSAL_CODES } from '../src/renderer/src/lib/gc-jobs'
import { MIB, blockOf, decideReason, modelOf, volume, wt } from './helpers/cleanup-gc-fixtures'

const t = (key: string, named?: Record<string, unknown>): string =>
  (named ? i18n.global.t(key, named) : i18n.global.t(key)) as string

function hydration(over: Partial<HydrationInfo> = {}): HydrationInfo {
  return {
    state: 'hydrated',
    removable: ['node_modules'],
    skipped: [],
    reclaimableBytes: 480_000_000,
    canRehydrate: true,
    rehydrateChanged: [],
    ...over
  }
}

function blockWith(
  bucket: Bucket,
  item: Partial<ReapItem> = {},
  reason = bucket === 'decide'
    ? decideReason('dirty', 'Merged with 1 modified tracked file.')
    : null
): GcBlock {
  return blockOf(
    wt(
      'x',
      bucket,
      1200 * MIB,
      { hydration: hydration(), verdict: 'blocked', ...item },
      {
        reason,
        stackIds: ['s1'],
        ownedVolumes: ['v1'],
        depsBytes: 400 * MIB
      }
    )
  )
}

type Props = {
  state?: BlockJobState | null
  failure?: ItemFailure | null
  removeVolumes?: boolean
  dehydrateIdleDays?: number
  hydrationBusy?: 'dehydrating' | 'rehydrating' | null
}

function mountPanel(block: GcBlock, props: Props = {}) {
  return mount(CleanupBlockPanel, {
    props: { block, state: null, failure: null, removeVolumes: true, ...props },
    global: { plugins: [i18n] }
  })
}

const has = (w: ReturnType<typeof mountPanel>, id: string): boolean =>
  w.find(`[data-testid="${id}"]`).exists()

describe('CleanupBlockPanel — actions by bucket and kind', () => {
  it('a corpse offers Clean now and nothing destructive besides', async () => {
    const w = mountPanel(blockWith('corpse', { verdict: 'harvestable', blockers: [] }))
    expect(has(w, 'panel-clean-now')).toBe(true)
    for (const id of [
      'panel-remove',
      'panel-keep',
      'panel-ask',
      'panel-dehydrate',
      'panel-retry'
    ]) {
      expect(has(w, id)).toBe(false)
    }
    await w.get('[data-testid="panel-clean-now"]').trigger('click')
    expect(w.emitted('cleanNow')).toHaveLength(1)
  })

  it('a Decide worktree offers Remove, Dehydrate, Keep and a disabled Ask with its tooltip', async () => {
    const w = mountPanel(blockWith('decide'))
    for (const id of ['panel-remove', 'panel-dehydrate', 'panel-keep', 'panel-ask']) {
      expect(has(w, id)).toBe(true)
    }
    const ask = w.get('[data-testid="panel-ask"]')
    expect(ask.attributes('disabled')).toBeDefined()
    expect(ask.attributes('title')).toBe(t('cleanup.gc.panel.askSoon'))
    await w.get('[data-testid="panel-remove"]').trigger('click')
    await w.get('[data-testid="panel-keep"]').trigger('click')
    await w.get('[data-testid="panel-dehydrate"]').trigger('click')
    await w.get('[data-testid="panel-ask"]').trigger('click')
    expect(w.emitted('remove')).toHaveLength(1)
    expect(w.emitted('keep')).toHaveLength(1)
    expect(w.emitted('dehydrate')).toHaveLength(1)
    expect(w.emitted('close')).toBeUndefined()
  })

  it('an Alive worktree has no destructive action — only Dehydrate once idle', () => {
    const idle = mountPanel(blockWith('alive', { ageDays: 34 }))
    expect(has(idle, 'panel-remove')).toBe(false)
    expect(has(idle, 'panel-keep')).toBe(false)
    expect(has(idle, 'panel-clean-now')).toBe(false)
    expect(has(idle, 'panel-dehydrate')).toBe(true)

    const fresh = mountPanel(blockWith('alive', { ageDays: 3 }))
    expect(has(fresh, 'panel-dehydrate')).toBe(false)
    const tuned = mountPanel(blockWith('alive', { ageDays: 3 }), { dehydrateIdleDays: 2 })
    expect(has(tuned, 'panel-dehydrate')).toBe(true)
  })

  it('an orphan volume names its project, offers Remove only, and warns it cannot be restored', async () => {
    const block = modelOf([], [volume('pg_data', 'old-app', 900 * MIB)]).byId.get('volume:pg_data')!
    const w = mountPanel(block)
    expect(w.get('[data-testid="panel-repo"]').text()).toBe(
      t('cleanup.gc.panel.project', { project: 'old-app' })
    )
    expect(w.get('[data-testid="panel-reason"]').text()).toBe(
      t('cleanup.gc.reason.noKnownWorktree')
    )
    expect(has(w, 'panel-remove')).toBe(true)
    for (const id of ['panel-keep', 'panel-ask', 'panel-dehydrate', 'panel-rehydrate']) {
      expect(has(w, id)).toBe(false)
    }
    expect(has(w, 'panel-volume-warning')).toBe(true)
    await w.get('[data-testid="panel-close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('shows what a removal takes with it, and the volume warning only when volumes go', () => {
    const w = mountPanel(blockWith('decide'))
    const lines = w.findAll('[data-testid="panel-takes"] li').map((l) => l.text())
    expect(lines).toHaveLength(5) // stack, volume, deps, checkout, branch
    expect(has(w, 'panel-volume-warning')).toBe(true)
    const keepVolumes = mountPanel(blockWith('decide'), { removeVolumes: false })
    expect(keepVolumes.findAll('[data-testid="panel-takes"] li')).toHaveLength(4)
    expect(has(keepVolumes, 'panel-volume-warning')).toBe(false)
  })

  it('draws the composition bar from deps and checkout, and lists volume names (no volume bytes exist)', () => {
    const w = mountPanel(blockWith('decide'))
    expect(has(w, 'panel-composition')).toBe(true)
    expect(w.get('[data-testid="panel-volumes"]').text()).toBe(
      t('cleanup.gc.panel.volumesNoSize', { names: 'v1' })
    )
  })

  it('shows the translated reason with the engine detail as a secondary line', () => {
    const w = mountPanel(blockWith('decide'))
    expect(w.get('[data-testid="panel-reason"]').text()).toBe(t('cleanup.gc.reason.dirty'))
    expect(w.get('[data-testid="panel-reason-detail"]').text()).toBe(
      'Merged with 1 modified tracked file.'
    )
  })

  it('while the item is being cleaned it says so and locks every action', () => {
    const w = mountPanel(blockWith('decide'), { state: 'busy' })
    expect(has(w, 'panel-busy')).toBe(true)
    for (const id of ['panel-remove', 'panel-keep', 'panel-dehydrate']) {
      expect(w.get(`[data-testid="${id}"]`).attributes('disabled')).toBeDefined()
    }
  })
})

describe('CleanupBlockPanel — a failed item', () => {
  const failure = (over: Partial<ItemFailure> = {}): ItemFailure => ({
    step: 'rm-volumes',
    error: 'volume pg-1 is in use by container pg-1',
    refusal: null,
    ...over
  })
  const failedBlock = () =>
    blockWith('decide', {}, decideReason('cleanup-failed', 'Cleanup stopped at step rm-volumes.'))

  it('lists what ran, what failed and what never started', () => {
    const w = mountPanel(failedBlock(), { failure: failure(), state: 'failed' })
    const states = Object.fromEntries(
      w
        .findAll('[data-testid="panel-steps"] li')
        .map((li) => [li.attributes('data-step'), li.attributes('data-state')])
    )
    expect(states['stop-stack']).toBe('ok')
    expect(states['rm-containers']).toBe('ok')
    expect(states['rm-volumes']).toBe('failed')
    expect(states['trash']).toBe('todo')
  })

  it('offers Retry, Keep and Remove', async () => {
    const w = mountPanel(failedBlock(), { failure: failure() })
    expect(has(w, 'panel-retry')).toBe(true)
    expect(has(w, 'panel-keep')).toBe(true)
    expect(has(w, 'panel-remove')).toBe(true)
    await w.get('[data-testid="panel-retry"]').trigger('click')
    expect(w.emitted('retry')).toHaveLength(1)
  })

  it('shows the raw error clamped to two lines, with the full text in the tooltip, and copies it', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const w = mountPanel(failedBlock(), { failure: failure() })
    const err = w.get('[data-testid="panel-error"]')
    expect(err.classes()).toContain('line-clamp-2')
    expect(err.attributes('title')).toBe('volume pg-1 is in use by container pg-1')
    await w.get('[data-testid="panel-copy-error"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith('volume pg-1 is in use by container pg-1')
  })

  it('says nothing destructive ran when the pre-flight reprobe refused it', () => {
    const w = mountPanel(failedBlock(), {
      failure: failure({ step: 'reprobe', error: 'refused' })
    })
    expect(has(w, 'panel-nothing-ran')).toBe(true)
  })

  it('a changed-since-confirm refusal is stated plainly instead of dumping the error', () => {
    const w = mountPanel(failedBlock(), {
      failure: failure({
        step: 'reprobe',
        error: CHANGED_SINCE_CONFIRM,
        refusal: 'changed-since-confirm'
      })
    })
    expect(w.get('[data-testid="panel-refusal"]').text()).toBe(
      t('cleanup.gc.refusal.changedSinceConfirm')
    )
    expect(has(w, 'panel-error')).toBe(false)
  })

  it.each(REFUSAL_CODES)('the %s refusal gets its own human sentence', (code) => {
    const w = mountPanel(failedBlock(), {
      failure: failure({ step: 'reprobe', error: code, refusal: code })
    })
    const sentence = w.get('[data-testid="panel-refusal"]').text()
    expect(sentence).not.toBe(code)
    expect(sentence).not.toContain('cleanup.gc.refusal')
    expect(has(w, 'panel-error')).toBe(false)
  })
})

// The legality cases of the retired CleanupView row cluster (T250), now decided on the panel.
describe('CleanupBlockPanel — hydration legality', () => {
  it('offers Dehydrate on a detached worktree, with the bytes it frees', () => {
    const w = mountPanel(
      blockWith('decide', {
        kind: 'detached-worktree',
        branch: undefined,
        blockers: ['detached-head'],
        path: '/w/repo/.claude/worktrees/det'
      })
    )
    const btn = w.get('[data-testid="panel-dehydrate"]')
    expect(btn.attributes('aria-label')).toBe(
      t('cleanup.a11y.dehydrateSize', { what: '.claude/worktrees/det', size: '480 MB' })
    )
  })

  it('dehydrated and blocked: the "dehydrated" marker and Rehydrate — no Dehydrate', async () => {
    const w = mountPanel(
      blockWith('decide', { hydration: hydration({ state: 'dehydrated', removable: [] }) })
    )
    expect(w.get('[data-testid="panel-hydration"]').text()).toBe(t('cleanup.state.dehydrated'))
    expect(has(w, 'panel-rehydrate')).toBe(true)
    expect(has(w, 'panel-dehydrate')).toBe(false)
    await w.get('[data-testid="panel-rehydrate"]').trigger('click')
    expect(w.emitted('rehydrate')).toHaveLength(1)
  })

  it('says "no setup" in the marker and offers no Rehydrate when Harnu cannot rehydrate', () => {
    const w = mountPanel(
      blockWith('decide', {
        hydration: hydration({ state: 'dehydrated', removable: [], canRehydrate: false })
      })
    )
    expect(w.get('[data-testid="panel-hydration"]').text()).toBe(
      t('cleanup.state.dehydratedNoRehydrate')
    )
    expect(has(w, 'panel-rehydrate')).toBe(false)
  })

  it('warns in the Dehydrate label when Harnu could not bring the folders back', () => {
    const w = mountPanel(blockWith('decide', { hydration: hydration({ canRehydrate: false }) }))
    expect(w.get('[data-testid="panel-dehydrate"]').attributes('aria-label')).toBe(
      t('cleanup.a11y.dehydrateNoSetup', { what: 'feat/x' })
    )
  })

  it('a corpse with dependencies installed is just cleaned — no Dehydrate beside Clean now', () => {
    const w = mountPanel(blockWith('corpse', { verdict: 'harvestable', blockers: [] }))
    expect(has(w, 'panel-clean-now')).toBe(true)
    expect(has(w, 'panel-dehydrate')).toBe(false)
  })

  it('names the lockfile a rehydrate rewrote, in the warning tone', () => {
    const w = mountPanel(
      blockWith('decide', {
        hydration: hydration({ removable: [], rehydrateChanged: ['package-lock.json'] })
      })
    )
    const m = w.get('[data-testid="panel-hydration"]')
    expect(m.text()).toBe(t('cleanup.state.rehydrateChanged', { file: 'package-lock.json' }))
    expect(m.classes()).toContain('text-warning')
  })

  it('offers nothing to dehydrate on a repo that commits vendor/, and says why in the meta tooltip', () => {
    const w = mountPanel(
      blockWith('decide', {
        hydration: hydration({ removable: [], skipped: [{ path: 'vendor', reason: 'tracked' }] })
      })
    )
    expect(has(w, 'panel-dehydrate')).toBe(false)
    const meta = w.get('[data-testid="panel-meta"]')
    expect(meta.attributes('title')).toBe(
      t('cleanup.state.kept', {
        items: `vendor — ${t('cleanup.dehydrateConfirm.skip.tracked')}`
      })
    )
  })

  it('an in-flight dehydrate/rehydrate shows its marker and disables both buttons', () => {
    const busy = mountPanel(blockWith('decide'), { hydrationBusy: 'dehydrating' })
    expect(busy.get('[data-testid="panel-hydration"]').text()).toBe(t('cleanup.state.dehydrating'))
    expect(busy.get('[data-testid="panel-dehydrate"]').attributes('disabled')).toBeDefined()
    // Remove stays available: only the two hydration buttons are tied to the operation.
    expect(busy.get('[data-testid="panel-remove"]').attributes('disabled')).toBeUndefined()

    const re = mountPanel(
      blockWith('decide', { hydration: hydration({ state: 'dehydrated', removable: [] }) }),
      { hydrationBusy: 'rehydrating' }
    )
    expect(re.get('[data-testid="panel-rehydrate"]').attributes('disabled')).toBeDefined()
  })
})
