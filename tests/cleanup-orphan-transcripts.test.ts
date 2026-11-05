// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import CleanupOtherItems from '../src/renderer/src/components/CleanupOtherItems.vue'
import CleanupTranscriptsConfirmDialog from '../src/renderer/src/components/CleanupTranscriptsConfirmDialog.vue'
import { i18n } from '@renderer/i18n'
import {
  groupOrphanTranscripts,
  orphanDigestState,
  splitByProof,
  transcriptCleanRequest,
  transcriptExpectedFor
} from '../src/renderer/src/lib/gc-orphans'
import { orphanExpectedOf, type OrphanTranscriptItem } from '../src/main/gc/gc-orphan-transcripts'
import { formatBytes } from '../src/renderer/src/components/system-monitor-format'
import { parseOptions } from '../src/main/gc/gc-options'

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
    proof: 'proven',
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

describe('"Folder not found": missing, but nothing proves it gone (delta-2 item 1)', () => {
  const nf = (slug: string, over: Partial<OrphanTranscriptItem> = {}): OrphanTranscriptItem =>
    item(slug, { proof: 'not-found', folder: `/home/u/remote/${slug}`, ...over })

  it('splitByProof keeps the two groups apart', () => {
    const { proven, notFound } = splitByProof([item('a'), nf('b'), item('c')])
    expect(proven.map((i) => i.slug)).toEqual(['a', 'c'])
    expect(notFound.map((i) => i.slug)).toEqual(['b'])
  })

  it('the request adds the stronger confirm for not-found ids only, and only when acknowledged', () => {
    const a = item('a')
    const b = nf('b')
    const withAck = structuredClone(transcriptCleanRequest([a, b], true))
    expect(withAck.options.confirmed).toEqual([a.id, b.id])
    expect(withAck.options.confirmedNotFound).toEqual([b.id])
    expect(withAck.options.expected[b.id]).toEqual(orphanExpectedOf(b))
    expect(transcriptCleanRequest([a, b], false).options.confirmedNotFound).toBeUndefined()
    expect(transcriptCleanRequest([a], true).options.confirmedNotFound).toBeUndefined()
  })

  describe('on the screen', () => {
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

    it('lists them in their own section with the FULL path, apart from the proven ones', () => {
      const w = mountIt([item('a'), nf('b')])
      expect(w.findAll('[data-testid="orphan-group"]')).toHaveLength(1)
      const section = w.get('[data-testid="orphan-notfound"]')
      expect(section.text()).toContain(t('cleanup.gc.orphans.notFound.title'))
      expect(section.text()).toContain(t('cleanup.gc.orphans.notFound.note'))
      expect(section.get('[data-testid="orphan-fullpath"]').text()).toBe('/home/u/remote/b')
    })

    it('has no such section when everything is proven', () => {
      expect(
        mountIt([item('a')])
          .find('[data-testid="orphan-notfound"]')
          .exists()
      ).toBe(false)
    })

    it('Delete on a not-found row asks for that row; Delete all in the section for the section', async () => {
      const b = nf('b')
      const c = nf('c')
      const w = mountIt([item('a'), b, c])
      await w
        .findAll('[data-testid="orphan-notfound"] [data-testid="orphan-delete"]')[0]!
        .trigger('click')
      expect(w.emitted('deleteTranscripts')![0]).toEqual([[b.id]])
      await w.get('[data-testid="orphan-notfound-delete-all"]').trigger('click')
      expect(w.emitted('deleteTranscripts')![1]).toEqual([[b.id, c.id]])
    })
  })

  describe('the confirm', () => {
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

    it('a proven-only dialog has no acknowledgement and confirms with ack false', async () => {
      const w = await open([item('a')])
      expect(q('[data-testid="orphan-dialog-ack"]')).toBeNull()
      q('[data-testid="orphan-dialog-confirm"]')!.click()
      expect(w.emitted('confirm')![0]).toEqual([{ notFoundAck: false, undigestedAck: false }])
    })

    it('a not-found dialog shows the full paths and will not confirm until the box is ticked', async () => {
      const w = await open([nf('b')])
      expect(q('[data-testid="orphan-dialog"]')!.textContent).toContain('/home/u/remote/b')
      expect(q('[data-testid="orphan-dialog"]')!.textContent).toContain(
        t('cleanup.gc.orphans.notFound.ack')
      )
      const confirm = q('[data-testid="orphan-dialog-confirm"]') as HTMLButtonElement
      expect(confirm.disabled).toBe(true)
      confirm.click()
      expect(w.emitted('confirm')).toBeUndefined()
      q('[data-testid="orphan-dialog-ack"]')!.click()
      await flushPromises()
      expect((q('[data-testid="orphan-dialog-confirm"]') as HTMLButtonElement).disabled).toBe(false)
      q('[data-testid="orphan-dialog-confirm"]')!.click()
      expect(w.emitted('confirm')![0]).toEqual([{ notFoundAck: true, undigestedAck: false }])
    })
  })
})

/**
 * Memory U1 S-6: Cleanup shows what was digested. A transcripts row says whether its sessions are in
 * the owning repo's memory; the confirm lists what is not and asks for "Trash without a digest" before
 * the Trash button works (S-5 refuses an undigested project without it, so this is the way forward).
 */
describe('memory digests on orphaned transcripts (S-6)', () => {
  const HOME = '/ws/org/proj/www'
  const digested = (done: number, total: number, home: string | null = HOME) => ({
    digest: { done, total, home }
  })

  describe('lib/gc-orphans orphanDigestState', () => {
    it('reads the item the way the chip does', () => {
      expect(orphanDigestState(item('a', digested(3, 3)))).toEqual({ kind: 'digested', missing: 0 })
      expect(orphanDigestState(item('a', digested(1, 3)))).toEqual({ kind: 'partial', missing: 2 })
      expect(orphanDigestState(item('a', digested(0, 2, null)))).toEqual({
        kind: 'partial',
        missing: 2
      })
      // Nothing worth a digest, or the gather did not say: no claim either way.
      expect(orphanDigestState(item('a', digested(0, 0)))).toEqual({ kind: 'none', missing: 0 })
      expect(orphanDigestState(item('a'))).toEqual({ kind: 'none', missing: 0 })
    })
  })

  describe('the row chip', () => {
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

    it('shows Digested when every counted session is digested, after the memory chip', () => {
      const w = mountIt([item('a', { hasMemory: true, ...digested(3, 3) })])
      const chip = w.get('[data-testid="orphan-digest"]')
      expect(chip.text()).toBe(t('cleanup.gc.orphans.digest.done'))
      expect(chip.attributes('data-state')).toBe('digested')
      const memory = w.get('[data-testid="orphan-memory"]').element
      expect(memory.compareDocumentPosition(chip.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      )
    })

    it('shows "N not digested" when some session has no digest', () => {
      const w = mountIt([item('a', digested(1, 4))])
      const chip = w.get('[data-testid="orphan-digest"]')
      expect(chip.text()).toBe(t('cleanup.gc.orphans.digest.partial', { n: 3 }))
      expect(chip.text()).toContain('3')
      expect(chip.attributes('data-state')).toBe('partial')
    })

    it('shows nothing when no session is counted or the item carries no digest', () => {
      const w = mountIt([item('a', digested(0, 0)), item('b')])
      expect(w.findAll('[data-testid="orphan-digest"]')).toHaveLength(0)
    })

    it('mixed digest states: each row carries its own chip, Folder-not-found rows too', () => {
      const w = mountIt([
        item('a', { bytes: 30 * MIB, ...digested(2, 2) }),
        item('b', { bytes: 20 * MIB, ...digested(0, 2, null) }),
        item('c', { bytes: 10 * MIB }),
        item('d', { proof: 'not-found', folder: '/home/u/remote/d', ...digested(1, 3) })
      ])
      const rows = w.findAll('[data-testid="orphan-row"]')
      expect(
        rows.map((r) => {
          const chip = r.find('[data-testid="orphan-digest"]')
          return chip.exists() ? chip.attributes('data-state') : undefined
        })
      ).toEqual(['digested', 'partial', undefined, 'partial'])
    })
  })

  describe('the confirm', () => {
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
    const confirmBtn = (): HTMLButtonElement =>
      q('[data-testid="orphan-dialog-confirm"]') as HTMLButtonElement

    it('undigested items need an explicit choice', async () => {
      const w = await open([item('a', digested(2, 2)), item('b', digested(1, 3))])
      expect(q('[data-testid="orphan-dialog-undigested-ack"]')).not.toBeNull()
      expect(q('[data-testid="orphan-dialog-undigested-label"]')!.textContent).toContain(
        t('cleanup.gc.orphans.confirm.undigested.ack')
      )
      expect(confirmBtn().disabled).toBe(true)
      confirmBtn().click()
      expect(w.emitted('confirm')).toBeUndefined()
      q('[data-testid="orphan-dialog-undigested-ack"]')!.click()
      await flushPromises()
      expect(confirmBtn().disabled).toBe(false)
      confirmBtn().click()
      expect(w.emitted('confirm')![0]).toEqual([{ notFoundAck: false, undigestedAck: true }])
    })

    it('a fully digested selection has no such choice and confirms as before', async () => {
      const w = await open([item('a', digested(2, 2)), item('b', digested(0, 0)), item('c')])
      expect(q('[data-testid="orphan-dialog-undigested-ack"]')).toBeNull()
      expect(q('[data-testid="orphan-dialog-undigested"]')).toBeNull()
      expect(confirmBtn().disabled).toBe(false)
      confirmBtn().click()
      expect(w.emitted('confirm')![0]).toEqual([{ notFoundAck: false, undigestedAck: false }])
    })

    it('says how many sessions are not digested and where digests went', async () => {
      await open([item('a', digested(1, 3)), item('b', digested(0, 2, '/ws/org/other/www'))])
      const callout = q('[data-testid="orphan-dialog-undigested"]')!
      expect(callout.textContent).toContain(
        t('cleanup.gc.orphans.confirm.undigested.summary', { n: 4 })
      )
      const rows = [...document.body.querySelectorAll('[data-testid="orphan-dialog-digest"]')]
      expect(rows).toHaveLength(2)
      expect(rows[0]!.textContent).toContain(HOME)
      expect(rows[0]!.textContent).toContain('2')
      expect(rows[1]!.textContent).toContain('/ws/org/other/www')
    })

    it('a project with no owning repo says so, and Cancel stays the way out', async () => {
      const w = await open([item('a', digested(0, 2, null))])
      expect(
        document.body.querySelector('[data-testid="orphan-dialog-digest"]')!.textContent
      ).toContain(t('cleanup.gc.orphans.confirm.undigested.noHome'))
      expect(q('[data-testid="orphan-dialog-undigested-ack"]')).not.toBeNull()
      expect(document.activeElement).toBe(q('[data-testid="orphan-dialog-cancel"]'))
      q('[data-testid="orphan-dialog-cancel"]')!.click()
      expect(w.emitted('cancel')).toHaveLength(1)
    })

    it('a not-found folder with undigested sessions needs both boxes', async () => {
      const w = await open([
        item('b', { proof: 'not-found', folder: '/home/u/remote/b', ...digested(0, 1) })
      ])
      q('[data-testid="orphan-dialog-ack"]')!.click()
      await flushPromises()
      expect(confirmBtn().disabled).toBe(true)
      q('[data-testid="orphan-dialog-undigested-ack"]')!.click()
      await flushPromises()
      expect(confirmBtn().disabled).toBe(false)
      confirmBtn().click()
      expect(w.emitted('confirm')![0]).toEqual([{ notFoundAck: true, undigestedAck: true }])
    })
  })

  describe('the request', () => {
    it('sends confirmedUndigested for exactly the undigested ids, and only when ticked', () => {
      const ok = item('a', digested(2, 2))
      const half = item('b', digested(1, 3))
      const none = item('c')
      const ticked = structuredClone(transcriptCleanRequest([ok, half, none], false, true))
      expect(ticked.options.confirmed).toEqual([ok.id, half.id, none.id])
      expect(ticked.options.confirmedUndigested).toEqual([half.id])
      expect(transcriptCleanRequest([ok, half], false, false).options.confirmedUndigested).toBe(
        undefined
      )
      expect(transcriptCleanRequest([ok, none], false, true).options.confirmedUndigested).toBe(
        undefined
      )
    })

    it('rides through the IPC parse intact, and the parse keeps at most 500 ids', () => {
      const half = item('b', digested(1, 3))
      const sent = parseOptions(
        structuredClone(transcriptCleanRequest([half], false, true).options)
      )
      expect(sent.confirmedUndigested).toEqual([half.id])
      expect(sent.confirmed).toEqual([half.id])
      const many = Array.from({ length: 600 }, (_, i) => `transcripts:s${i}`)
      expect(parseOptions({ confirmedUndigested: many }).confirmedUndigested).toHaveLength(500)
    })
  })
})
