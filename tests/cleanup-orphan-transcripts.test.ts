// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import CleanupOtherItems from '../src/renderer/src/components/CleanupOtherItems.vue'
import CleanupTranscriptsConfirmDialog from '../src/renderer/src/components/CleanupTranscriptsConfirmDialog.vue'
import { i18n } from '@renderer/i18n'
import {
  groupOrphanTranscripts,
  transcriptCleanRequest,
  transcriptExpectedFor
} from '../src/renderer/src/lib/gc-orphans'
import { orphanExpectedOf, type OrphanTranscriptItem } from '../src/main/gc/gc-orphan-transcripts'
import { formatBytes } from '../src/renderer/src/components/system-monitor-format'

/**
 * AC-D1, the screen: orphaned transcripts sit under "Other leftovers" with their size, grouped by
 * repo; "Delete" asks first and sends the request main checks against what was shown.
 */

const t = (key: string, named?: Record<string, unknown>): string =>
  (named ? i18n.global.t(key, named) : i18n.global.t(key)) as string

const MIB = 1024 ** 2
function item(slug: string, over: Partial<OrphanTranscriptItem> = {}): OrphanTranscriptItem {
  return {
    id: `transcripts:${slug}`,
    slug,
    folder: `/ws/org/proj/worktrees/${slug}`,
    repoLabel: 'proj',
    bytes: 10 * MIB,
    sessionCount: 3,
    newestAt: Date.parse('2026-10-01T12:00:00Z'),
    hasMemory: false,
    ...over
  }
}

describe('lib/gc-orphans', () => {
  it('groups by repo, biggest group first, with totals', () => {
    const groups = groupOrphanTranscripts([
      item('a', { repoLabel: 'proj', bytes: 5 * MIB }),
      item('b', { repoLabel: 'portal', bytes: 30 * MIB }),
      item('c', { repoLabel: 'proj', bytes: 20 * MIB })
    ])
    expect(groups.map((g) => [g.repoLabel, g.bytes, g.items.map((i) => i.slug)])).toEqual([
      ['portal', 30 * MIB, ['b']],
      ['proj', 25 * MIB, ['c', 'a']]
    ])
  })

  it('the expected facts mirror main exactly', () => {
    const it1 = item('a', { hasMemory: true })
    expect(transcriptExpectedFor(it1)).toEqual(orphanExpectedOf(it1))
  })

  it('the request confirms every id it lists, and survives a structured clone', () => {
    const a = item('a')
    const b = item('b')
    const req = structuredClone(transcriptCleanRequest([a, b]))
    expect(req.ids).toEqual([a.id, b.id])
    expect(req.options.confirmed).toEqual([a.id, b.id])
    expect(req.options.expected[a.id]).toEqual(orphanExpectedOf(a))
  })
})

describe('CleanupOtherItems with orphaned transcripts', () => {
  let wrapper: VueWrapper | null = null
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })
  const mountIt = (transcripts: OrphanTranscriptItem[]): VueWrapper => {
    setActivePinia(createPinia())
    wrapper = mount(CleanupOtherItems, {
      props: { transcripts },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    return wrapper
  }

  it('renders nothing when there is nothing to show', () => {
    const w = mountIt([])
    expect(w.find('[data-testid="cleanup-other"]').exists()).toBe(false)
  })

  it('lists each folder with its size and sessions, under its repo', () => {
    const w = mountIt([
      item('a', { bytes: 5 * MIB, sessionCount: 1 }),
      item('b', { bytes: 30 * MIB, repoLabel: 'portal' })
    ])
    const groups = w.findAll('[data-testid="orphan-group"]')
    expect(groups.map((g) => g.get('[data-testid="orphan-group-label"]').text())).toEqual([
      'portal',
      'proj'
    ])
    const rows = w.findAll('[data-testid="orphan-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain(formatBytes(30 * MIB))
    expect(rows[1]!.text()).toContain(t('cleanup.gc.orphans.sessions', { n: 1 }))
    expect(
      w.get('[data-testid="orphan-row"] [data-testid="orphan-folder"]').attributes('title')
    ).toBe('/ws/org/proj/worktrees/b')
  })

  it('says when the folder also holds memory notes', () => {
    const w = mountIt([item('a', { hasMemory: true })])
    expect(w.get('[data-testid="orphan-memory"]').text()).toBe(t('cleanup.gc.orphans.memory'))
  })

  it('Delete on a row asks to delete exactly that row; Delete all asks for every row', async () => {
    const a = item('a')
    const b = item('b')
    const w = mountIt([a, b])
    await w.findAll('[data-testid="orphan-delete"]')[0]!.trigger('click')
    expect(w.emitted('deleteTranscripts')![0]).toEqual([[a.id]])
    await w.get('[data-testid="orphan-delete-all"]').trigger('click')
    expect(w.emitted('deleteTranscripts')![1]).toEqual([[a.id, b.id]])
  })

  it('a row mid-delete cannot be asked for again', async () => {
    const a = item('a')
    setActivePinia(createPinia())
    wrapper = mount(CleanupOtherItems, {
      props: { transcripts: [a], busy: [a.id] },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    expect(wrapper.get('[data-testid="orphan-delete"]').attributes('disabled')).toBeDefined()
  })
})

describe('CleanupTranscriptsConfirmDialog', () => {
  let wrapper: VueWrapper | null = null
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })
  const open = async (items: OrphanTranscriptItem[]): Promise<VueWrapper> => {
    wrapper = mount(CleanupTranscriptsConfirmDialog, {
      props: { items },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    await flushPromises()
    return wrapper
  }
  const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)

  it('says it goes to the trash, lists the folders and totals the size', async () => {
    await open([item('a', { bytes: 4 * MIB }), item('b', { bytes: 6 * MIB })])
    expect(q('[data-testid="orphan-dialog"]')!.textContent).toContain(
      t('cleanup.gc.orphans.confirm.recoverable')
    )
    expect(document.body.querySelectorAll('[data-testid="orphan-dialog-row"]')).toHaveLength(2)
    expect(q('[data-testid="orphan-dialog-total"]')!.textContent).toContain(formatBytes(10 * MIB))
  })

  it('focus starts on Cancel, never the confirm; confirm and cancel emit', async () => {
    const w = await open([item('a')])
    expect(document.activeElement).toBe(q('[data-testid="orphan-dialog-cancel"]'))
    q('[data-testid="orphan-dialog-confirm"]')!.click()
    expect(w.emitted('confirm')).toHaveLength(1)
    q('[data-testid="orphan-dialog-cancel"]')!.click()
    expect(w.emitted('cancel')).toHaveLength(1)
  })

  it('warns when a folder also holds memory notes', async () => {
    await open([item('a', { hasMemory: true })])
    expect(q('[data-testid="orphan-dialog-memory"]')).not.toBeNull()
  })

  it('Escape closes the dialog only', async () => {
    const w = await open([item('a')])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(w.emitted('cancel')).toBeTruthy()
  })
})
