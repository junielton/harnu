// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CleanupTreemap from '../src/renderer/src/components/CleanupTreemap.vue'
import { i18n } from '@renderer/i18n'
import type { BlockJobState } from '../src/renderer/src/lib/gc-jobs'
import { GIB, MIB, reviewReason, modelOf, wt } from './helpers/cleanup-gc-fixtures'

const t = (key: string, named?: Record<string, unknown>): string =>
  (named ? i18n.global.t(key, named) : i18n.global.t(key)) as string

type Props = {
  blockState?: (id: string) => BlockJobState | null
  checked?: string[]
  selectedId?: string | null
  linkedId?: string | null
  planned?: boolean
  drillRepo?: string | null
}

function mountMap(model: ReturnType<typeof modelOf>, props: Props = {}, attach = false) {
  return mount(CleanupTreemap, {
    props: {
      model,
      blockState: props.blockState ?? (() => null),
      checked: new Set(props.checked ?? []),
      selectedId: props.selectedId ?? null,
      linkedId: props.linkedId ?? null,
      planned: props.planned ?? false,
      drillRepo: props.drillRepo ?? null
    },
    global: { plugins: [i18n] },
    attachTo: attach ? document.body : undefined
  })
}

const sample = () =>
  modelOf([
    wt('PROJ-0412-login', 'ready', 3 * GIB),
    wt('d1', 'review', 2 * GIB, {}, { reason: reviewReason('dirty') }),
    wt('d2', 'review', 1 * GIB, {}, { reason: reviewReason('closed-unmerged') }),
    wt('a1', 'in-use', 1 * GIB)
  ])

const blocks = (w: ReturnType<typeof mountMap>) => w.findAll('[data-testid="treemap-block"]')
const byName = (w: ReturnType<typeof mountMap>, name: string) =>
  blocks(w).find((b) => b.find('.tm-b-name').text() === name)!

describe('CleanupTreemap — blocks', () => {
  it('draws one button per worktree with its bucket and an accessible name', () => {
    const w = mountMap(sample())
    expect(blocks(w)).toHaveLength(4)
    const d1 = byName(w, 'd1')
    expect(d1.element.tagName).toBe('BUTTON')
    expect(d1.attributes('data-bucket')).toBe('review')
    // Expected text comes from the same catalog, so this holds whatever the locale wording is.
    expect(d1.attributes('aria-label')).toBe(
      t('cleanup.gc.map.blockLabel', {
        name: 'd1',
        bucket: t('cleanup.gc.bucket.review'),
        size: '2.15 GB'
      })
    )
    expect(d1.attributes('title')).toContain('d1')
  })

  it('groups blocks under repo and bucket headers', () => {
    const w = mountMap(sample())
    expect(w.findAll('[data-testid="treemap-region"]')).toHaveLength(1)
    for (const b of ['ready', 'review', 'in-use']) {
      expect(w.find(`[data-testid="treemap-group-${b}"]`).exists()).toBe(true)
    }
    expect(w.text()).toContain(t('cleanup.gc.bucket.header.review'))
  })

  it('carries the label ladder: full name, ticket id and #id in the DOM, CSS picks one', () => {
    const w = mountMap(sample())
    const b = blocks(w).find((x) => x.find('.tm-b-name').text() === 'PROJ-0412-login')!
    expect(b.find('.tm-b-short').text()).toBe('PROJ-0412')
    expect(b.find('.tm-b-tiny').text()).toBe('#0412')
    expect(b.find('.tm-b-size').text()).toBe('3.22 GB')
  })
})

describe('CleanupTreemap — the tooltip tells the truth about the block', () => {
  const title = (w: ReturnType<typeof mountMap>, name: string): string =>
    byName(w, name).attributes('title') ?? ''

  it('an In use block says why it is In use, never the Ready sentence', () => {
    const w = mountMap(
      modelOf([
        wt('live', 'in-use', 2 * GIB, {}, { session: 'working' }),
        wt('pr', 'in-use', 2 * GIB, {}, { fate: { fate: 'open', signal: null, strong: false } }),
        wt('ready1', 'ready', 2 * GIB)
      ])
    )
    expect(title(w, 'live')).toContain(
      `${t('cleanup.gc.bucket.in-use')} — ${t('cleanup.gc.reason.inUse.sessionWorking')}`
    )
    expect(title(w, 'pr')).toContain(t('cleanup.gc.reason.inUse.openPr'))
    expect(title(w, 'live')).not.toContain(t('cleanup.gc.reason.ready'))
    expect(title(w, 'ready1')).toContain(
      `${t('cleanup.gc.bucket.ready')} — ${t('cleanup.gc.reason.ready')}`
    )
  })

  it('a Needs review block keeps its own reason, with its bucket word', () => {
    const w = mountMap(sample())
    expect(title(w, 'd1')).toContain(
      `${t('cleanup.gc.bucket.review')} — ${t('cleanup.gc.reason.dirty')}`
    )
  })
})

describe('CleanupTreemap — states', () => {
  it('a checked block gets the outline AND the check badge; a merely selected one gets no badge', () => {
    const m = sample()
    const d1 = m.blocks.find((b) => b.name === 'd1')!
    const d2 = m.blocks.find((b) => b.name === 'd2')!
    const w = mountMap(m, { checked: [d1.id], selectedId: d2.id })
    const checked = byName(w, 'd1')
    expect(checked.classes()).toContain('is-checked')
    expect(checked.attributes('aria-pressed')).toBe('true')
    expect(checked.find('[data-testid="treemap-check"]').exists()).toBe(true)
    const selected = byName(w, 'd2')
    expect(selected.classes()).toContain('is-selected')
    expect(selected.attributes('aria-pressed')).toBe('false')
    expect(selected.find('[data-testid="treemap-check"]').exists()).toBe(false)
    expect(w.findAll('[data-testid="treemap-check"]')).toHaveLength(1)
  })

  it('outlines the block whose list row is hovered', () => {
    const m = sample()
    const w = mountMap(m, { linkedId: m.blocks.find((b) => b.name === 'a1')!.id })
    expect(byName(w, 'a1').classes()).toContain('is-linked')
  })

  it('busy: accent tint, a dot and a progress sliver', () => {
    const m = sample()
    const id = m.blocks.find((b) => b.name === 'PROJ-0412-login')!.id
    const w = mountMap(m, { blockState: (x) => (x === id ? 'busy' : null) })
    const b = blocks(w).find((x) => x.attributes('data-state') === 'busy')!
    expect(b.classes()).toContain('is-busy')
    expect(b.classes()).toContain('bg-accent-soft')
    expect(b.find('[data-testid="treemap-busy-dot"]').exists()).toBe(true)
    expect(b.find('[data-testid="treemap-busy-bar"]').exists()).toBe(true)
  })

  it('done: faded, dashed, says "freed"', () => {
    const m = sample()
    const id = m.blocks.find((b) => b.name === 'PROJ-0412-login')!.id
    const w = mountMap(m, { blockState: (x) => (x === id ? 'done' : null) })
    const b = blocks(w).find((x) => x.attributes('data-state') === 'done')!
    expect(b.classes()).toEqual(expect.arrayContaining(['is-done', 'opacity-45', 'border-dashed']))
    expect(b.find('[data-testid="treemap-freed"]').text()).toContain(t('cleanup.gc.map.freed'))
    expect(b.attributes('aria-label')).toBe(
      t('cleanup.gc.map.blockLabelState', {
        name: 'PROJ-0412-login',
        bucket: t('cleanup.gc.bucket.ready'),
        size: '3.22 GB',
        state: t('cleanup.gc.map.state.done')
      })
    )
  })

  it('failed: red-line border and the alert icon in place of the bucket icon', () => {
    const m = sample()
    const id = m.blocks.find((b) => b.name === 'd1')!.id
    const w = mountMap(m, { blockState: (x) => (x === id ? 'failed' : null) })
    const b = blocks(w).find((x) => x.attributes('data-state') === 'failed')!
    expect(b.classes()).toEqual(expect.arrayContaining(['is-failed', 'border-red-line']))
    expect(b.find('.lucide-triangle-alert').exists()).toBe(true)
  })

  it('first cycle: ready blocks are dashed ("planned"), Needs review and In use are not', () => {
    const w = mountMap(sample(), { planned: true })
    expect(blocks(w).filter((b) => b.classes().includes('is-planned'))).toHaveLength(1)
    expect(byName(w, 'PROJ-0412-login').classes()).toContain('border-dashed')
    expect(byName(w, 'd1').classes()).not.toContain('border-dashed')
  })

  it('Needs review blocks carry the hatch class; the others do not', () => {
    const w = mountMap(sample())
    expect(byName(w, 'd1').classes()).toContain('tm-hatch')
    expect(byName(w, 'a1').classes()).not.toContain('tm-hatch')
  })
})

describe('CleanupTreemap — interaction', () => {
  it('a plain click opens the block', async () => {
    const w = mountMap(sample())
    await byName(w, 'd1').trigger('click')
    const m = w.props('model')
    expect(w.emitted('select')?.[0]).toEqual([m.blocks.find((b) => b.name === 'd1')!.id])
    expect(w.emitted('toggle')).toBeUndefined()
  })

  it('Shift+click toggles a Needs review block', async () => {
    const w = mountMap(sample())
    await byName(w, 'd1').trigger('click', { shiftKey: true })
    expect(w.emitted('toggle')).toHaveLength(1)
    expect(w.emitted('select')).toBeUndefined()
  })

  it('Shift+click on a ready or an in-use block does nothing — only Needs review is selectable', async () => {
    const w = mountMap(sample())
    await byName(w, 'PROJ-0412-login').trigger('click', { shiftKey: true })
    await byName(w, 'a1').trigger('click', { shiftKey: true })
    expect(w.emitted('toggle')).toBeUndefined()
    expect(w.emitted('select')).toBeUndefined()
  })

  it('Space toggles a Needs review block and opens a ready block', async () => {
    const w = mountMap(sample())
    await byName(w, 'd2').trigger('keydown', { key: ' ' })
    expect(w.emitted('toggle')).toHaveLength(1)
    await byName(w, 'PROJ-0412-login').trigger('keydown', { key: ' ' })
    expect(w.emitted('select')).toHaveLength(1)
  })

  it('a done block cannot be opened', async () => {
    const m = sample()
    const id = m.blocks.find((b) => b.name === 'd1')!.id
    const w = mountMap(m, { blockState: (x) => (x === id ? 'done' : null) })
    await blocks(w)
      .find((b) => b.attributes('data-state') === 'done')!
      .trigger('click')
    expect(w.emitted('select')).toBeUndefined()
  })

  it('arrow keys move focus to a neighbouring block', async () => {
    const w = mountMap(sample(), {}, true)
    const first = blocks(w)[0]
    ;(first.element as HTMLElement).focus()
    const seen = new Set<Element | null>([document.activeElement])
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      await (
        w
          .findAll('[data-testid="treemap-block"]')
          .find((b) => b.element === document.activeElement) ?? first
      ).trigger('keydown', { key })
      await w.vm.$nextTick()
      seen.add(document.activeElement)
    }
    expect(seen.size).toBeGreaterThan(1)
    expect([...seen].every((e) => e === null || e.tagName === 'BUTTON')).toBe(true)
    w.unmount()
  })
})

describe('CleanupTreemap — aggregates, regions and drill-down', () => {
  const crowded = () =>
    modelOf([
      wt('big', 'review', 4 * GIB, {}, { reason: reviewReason('dirty') }),
      wt('s1', 'review', 10 * MIB, {}, { reason: reviewReason('dirty') }),
      wt('s2', 'review', 20 * MIB, {}, { reason: reviewReason('dirty') }),
      wt('s3', 'review', 30 * MIB, {}, { reason: reviewReason('dirty') })
    ])

  it('folds the long tail into one "N smaller" block that opens the folded set', async () => {
    const m = crowded()
    const w = mountMap(m)
    expect(blocks(w)).toHaveLength(1)
    const agg = w.get('[data-testid="treemap-aggregate"]')
    await agg.trigger('click')
    const [ids, bucket] = w.emitted('openAggregate')![0] as [string[], string]
    expect(bucket).toBe('review')
    expect(ids.sort()).toEqual(
      m.blocks
        .filter((b) => b.name.startsWith('s'))
        .map((b) => b.id)
        .sort()
    )
  })

  it('lets the repo header select all its Needs review blocks, and only when there are some', async () => {
    const w = mountMap(sample())
    await w.get('[data-testid="treemap-select-all"]').trigger('click')
    await w.get('[data-testid="treemap-select-all-icon"]').trigger('click')
    expect(w.emitted('selectAllInRepo')).toEqual([['/w/repo'], ['/w/repo']])

    const none = mountMap(modelOf([wt('c', 'ready', GIB)]))
    expect(none.find('[data-testid="treemap-select-all"]').exists()).toBe(false)
  })

  it('shows bucket counts on the repo header', () => {
    const w = mountMap(sample())
    expect(w.get('[data-testid="treemap-count-review"]').text()).toBe('2')
    expect(w.get('[data-testid="treemap-count-ready"]').text()).toBe('1')
  })

  it('clicking a repo drills in; the drilled view has a way back and only that repo', async () => {
    const m = modelOf([
      wt('a', 'ready', 2 * GIB),
      wt('b', 'ready', 2 * GIB, { repoPath: '/w/other', id: '/w/other::worktree::b' })
    ])
    const w = mountMap(m)
    expect(w.findAll('[data-testid="treemap-region"]')).toHaveLength(2)
    await w.findAll('[data-testid="treemap-repo"]')[0].trigger('click')
    expect(w.emitted('drill')![0][0]).toMatch(/^\/w\//)

    const drilled = mountMap(m, { drillRepo: '/w/repo' })
    expect(drilled.findAll('[data-testid="treemap-region"]')).toHaveLength(1)
    // No fixed height: the canvas is as tall as the layout needs (the map grows downward).
    expect(drilled.get('[data-testid="treemap-canvas"]').attributes('style')).toMatch(
      /height: [\d.]+px/
    )
    await drilled.get('[data-testid="treemap-back"]').trigger('click')
    expect(drilled.emitted('drill')![0]).toEqual([null])
  })

  it('without disk sizes there is no map — a notice sends the operator to the list', () => {
    const w = mountMap(modelOf([wt('c', 'ready', null), wt('d', 'review', null)]))
    expect(w.find('[data-testid="treemap-no-bytes"]').exists()).toBe(true)
    expect(w.find('[data-testid="treemap-canvas"]').exists()).toBe(false)
  })
})

describe('CleanupTreemap — the repo label', () => {
  it('wears a mono org/proj-style label in EVERY region, with the full path as its tooltip', () => {
    const model = modelOf([
      wt('a', 'ready', 5 * GIB, {
        repoPath: '/ws/org/proj/www',
        id: '/ws/org/proj/www::worktree::a'
      }),
      wt('b', 'review', 1 * GIB, { repoPath: '/ws/org/portal', id: '/ws/org/portal::worktree::b' }),
      wt('c', 'review', 1 * GIB, {
        repoPath: '/ws/org/api-gateway',
        id: '/ws/org/api-gateway::worktree::c'
      })
    ])
    const w = mountMap(model)
    const labels = w.findAll('[data-testid="treemap-repo"]')
    expect(labels.map((l) => l.text()).sort()).toEqual([
      'org/api-gateway',
      'org/portal',
      'proj/www'
    ])
    for (const l of labels) {
      expect(l.classes()).toContain('font-mono')
      expect(l.classes()).toContain('truncate')
      expect(l.attributes('title')).toMatch(/^\/ws\//)
    }
  })

  it('keeps the label out of the squeeze: the meta and badges yield first', () => {
    const w = mountMap(sample())
    const label = w.get('[data-testid="treemap-repo"]')
    // The name has its own line and takes all of it; the meta line yields (the worktree count first).
    expect(label.classes()).toEqual(expect.arrayContaining(['min-w-0', 'flex-1', 'truncate']))
    expect(w.get('.tm-rmeta').classes()).toContain('truncate')
    expect(w.get('.tm-rcount').exists()).toBe(true)
  })
})
