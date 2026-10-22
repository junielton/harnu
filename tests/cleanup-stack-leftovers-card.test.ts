// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import CleanupDockerCard from '../src/renderer/src/components/CleanupDockerCard.vue'
import CleanupDockerConfirmDialog from '../src/renderer/src/components/CleanupDockerConfirmDialog.vue'
import { i18n } from '@renderer/i18n'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import {
  leftoverVolumeRequest,
  stackCleanRequest,
  stackExpectedFor
} from '../src/renderer/src/lib/gc-orphans'
import { stackLeftoverExpectedOf, type StackLeftoverItem } from '../src/main/gc/gc-stack-leftovers'
import type { OrphanVolumeItem } from '../src/main/gc/gc-wire'
import { formatBytes } from '../src/renderer/src/components/system-monitor-format'
import { buildGcModel } from '../src/renderer/src/lib/gc-model'
import { snapshotOf } from './helpers/cleanup-gc-fixtures'

/**
 * AC-D3, the screen: the Docker card lists what removed worktrees left in Docker. Containers and
 * networks are cleaned with one confirm; volumes are listed apart and removed only by their own,
 * stronger confirm, never together with the stack.
 */

const t = (key: string, named?: Record<string, unknown>, plural?: number): string =>
  (plural === undefined
    ? i18n.global.t(key, named ?? {})
    : i18n.global.t(key, named ?? {}, plural)) as string

const leftover = (over: Partial<StackLeftoverItem> = {}): StackLeftoverItem => ({
  id: 'stack-leftover:pj',
  project: 'pj',
  dirs: ['/ws/gone'],
  containers: [
    { id: 'c1', name: 'pj-web-1', state: 'exited' },
    { id: 'c2', name: 'pj-db-1', state: 'created' }
  ],
  networks: [{ id: 'n1', name: 'pj_default' }],
  volumes: [{ id: 'volume:pj_data', name: 'pj_data', sizeBytes: 5_000_000 }],
  ...over
})

let wrapper: VueWrapper | null = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

function mountCard(leftovers: StackLeftoverItem[]): VueWrapper {
  wrapper = mount(CleanupDockerCard, {
    props: {
      orphanVolumes: { count: 0, bytes: 0 },
      volumes: [],
      docker: { buildCacheReclaimableBytes: null, danglingImages: null, orphanVolumesHidden: null },
      lastCycle: null,
      prefs: defaultGcPrefs(),
      leftovers
    },
    global: { plugins: [i18n] }
  })
  return wrapper
}

describe('the Docker card block "Left by removed worktrees"', () => {
  it('is absent when nothing was left', () => {
    expect(mountCard([]).find('[data-testid="docker-leftovers"]').exists()).toBe(false)
  })

  it('counts containers and networks, names the project, and offers Clean up', async () => {
    const w = mountCard([leftover()])
    const block = w.get('[data-testid="docker-leftovers"]')
    expect(block.text()).toContain(t('cleanup.gc.docker.leftovers.title'))
    expect(w.get('[data-testid="docker-leftovers-stack"]').text()).toContain(
      t('cleanup.gc.docker.leftovers.stack', { c: 2, n: 1 })
    )
    expect(block.text()).toContain('pj')
    await w.get('[data-testid="docker-leftovers-clean"]').trigger('click')
    expect(w.emitted('cleanLeftovers')![0]).toEqual([['stack-leftover:pj']])
  })

  it('lists volumes apart with their own button, never under Clean up', async () => {
    const w = mountCard([leftover()])
    const vols = w.get('[data-testid="docker-leftovers-volumes"]')
    expect(vols.text()).toContain(formatBytes(5_000_000))
    expect(vols.text()).toContain(t('cleanup.gc.docker.leftovers.volumesNote'))
    await w.get('[data-testid="docker-leftovers-volumes-remove"]').trigger('click')
    expect(w.emitted('removeLeftoverVolumes')![0]).toEqual([['volume:pj_data']])
    // The stack button never carries a volume.
    await w.get('[data-testid="docker-leftovers-clean"]').trigger('click')
    expect(w.emitted('cleanLeftovers')![0]).toEqual([['stack-leftover:pj']])
  })

  it('a project with only volumes has no Clean up button, and one with none has no Remove volumes', () => {
    const onlyVolumes = mountCard([leftover({ containers: [], networks: [] })])
    expect(onlyVolumes.find('[data-testid="docker-leftovers-clean"]').exists()).toBe(false)
    expect(onlyVolumes.find('[data-testid="docker-leftovers-volumes-remove"]').exists()).toBe(true)
    onlyVolumes.unmount()
    const noVolumes = mountCard([leftover({ volumes: [] })])
    expect(noVolumes.find('[data-testid="docker-leftovers-volumes"]').exists()).toBe(false)
  })
})

describe('the requests the card builds', () => {
  it('the stack request confirms each project on its own, with main’s expected facts', () => {
    const it1 = leftover()
    const req = structuredClone(stackCleanRequest([it1]))
    expect(req.ids).toEqual([it1.id])
    expect(req.options.confirmed).toEqual([it1.id])
    expect(req.options.expected[it1.id]).toEqual(stackLeftoverExpectedOf(it1))
    expect(stackExpectedFor(it1)).toEqual(stackLeftoverExpectedOf(it1))
    // No volume rides along.
    expect(JSON.stringify(req)).not.toContain('volume:')
  })

  it('the volumes go through the ordinary orphan-volume request, confirmed one by one', () => {
    const v: OrphanVolumeItem = {
      id: 'volume:pj_data',
      name: 'pj_data',
      sizeBytes: 5_000_000,
      project: 'pj',
      reason: { code: 'no-known-worktree', detail: 'x' }
    }
    const model = buildGcModel(snapshotOf([], [v]))
    const req = structuredClone(leftoverVolumeRequest(model, ['volume:pj_data']))
    expect(req.ids).toEqual(['volume:pj_data'])
    expect(req.options.confirmed).toEqual(['volume:pj_data'])
    expect(req.options.expected['volume:pj_data']).toMatchObject({
      bucket: 'orphan-volume',
      project: 'pj',
      bytes: 5_000_000
    })
  })
})

describe('CleanupDockerConfirmDialog', () => {
  const open = async (
    kind: 'stack' | 'volumes',
    items: StackLeftoverItem[] = [leftover()]
  ): Promise<VueWrapper> => {
    wrapper = mount(CleanupDockerConfirmDialog, {
      props: { kind, items },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    await flushPromises()
    return wrapper
  }
  const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)

  it('the stack dialog says nothing is lost that cannot be recreated, and never mentions volumes being removed', async () => {
    await open('stack')
    const d = q('[data-testid="docker-confirm"]')!
    expect(d.textContent).toContain(t('cleanup.gc.docker.confirm.stackNote'))
    expect(d.textContent).not.toContain(t('cleanup.gc.docker.confirm.volumesNote'))
    expect(q('[data-testid="docker-confirm-confirm"]')!.textContent).toContain(
      t('cleanup.gc.docker.confirm.stackConfirm')
    )
  })

  it('the volumes dialog is Danger and says volumes cannot be restored', async () => {
    await open('volumes')
    const d = q('[data-testid="docker-confirm"]')!
    expect(d.textContent).toContain(t('cleanup.gc.docker.confirm.volumesNote'))
    expect(d.textContent).toContain('pj_data')
    expect(q('[data-testid="docker-confirm-confirm"]')!.className).toMatch(/red|danger/)
  })

  it('focus starts on Cancel; confirm and cancel emit; Escape closes only the dialog', async () => {
    const w = await open('stack')
    expect(document.activeElement).toBe(q('[data-testid="docker-confirm-cancel"]'))
    q('[data-testid="docker-confirm-confirm"]')!.click()
    expect(w.emitted('confirm')).toHaveLength(1)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(w.emitted('cancel')).toHaveLength(1)
  })
})
