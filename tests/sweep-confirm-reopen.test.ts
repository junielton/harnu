// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SweepConfirmDialog from '../src/renderer/src/components/SweepConfirmDialog.vue'
import { useReaperStore } from '../src/renderer/src/stores/reaper'
import { i18n } from '@renderer/i18n'
import type { ReapItem, CleanResult } from '../src/preload'

/**
 * BUG: reopening the sweep confirm after a first sweep showed the dialog
 * already "done" — items pre-ticked and the Sweep button gone — because the
 * multi-item path read `store.progress`, which outlives the dialog and is only
 * cleared when the NEXT sweep starts. A freshly mounted dialog must always be
 * armed, whatever the store still holds from a previous run.
 */
function item(id: string): ReapItem {
  return {
    id,
    repoPath: '/repo',
    kind: 'remote-branch',
    branch: `feat/${id}`,
    path: null,
    hidden: false,
    ageDays: 30,
    diskBytes: null,
    checkpoints: [],
    blockers: [],
    needsRemoteDelete: true,
    untracked: [],
    justifiedBy: null,
    verdict: 'harvestable'
  } as unknown as ReapItem
}

function okResult(itemId: string): CleanResult {
  return { itemId, ok: true, steps: [] } as unknown as CleanResult
}

/** Main streams a per-item progress event as each step lands, then resolves. */
let onProgress: ((r: CleanResult) => void) | undefined
const reaperSweep = vi.fn(async ({ itemIds }: { itemIds: string[] }) => {
  const results = itemIds.map(okResult)
  results.forEach((r) => onProgress?.(r))
  return results
})

beforeEach(async () => {
  reaperSweep.mockClear()
  onProgress = undefined
  const api = {
    reaperSweep,
    reaperSnapshot: vi.fn(async () => null),
    reaperJournal: vi.fn(async () => []),
    onReaperProgress: (cb: (r: CleanResult) => void) => {
      onProgress = cb
      return () => {
        onProgress = undefined
      }
    }
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => () => {})
  })
  setActivePinia(createPinia())
  await useReaperStore().init()
})

const ITEMS = [item('a'), item('b')]

function mountDialog() {
  return mount(SweepConfirmDialog, {
    props: { items: ITEMS },
    global: { plugins: [i18n], stubs: { teleport: true } }
  })
}

function sweepButton(w: ReturnType<typeof mountDialog>) {
  return w.findAll('button').find((b) => b.text().trim() === 'Sweep')
}

describe('SweepConfirmDialog — reopen after a completed sweep', () => {
  it('is armed on a fresh mount even when the store still holds the last run', async () => {
    const first = mountDialog()
    await sweepButton(first)!.trigger('click')
    await flushPromises()
    expect(first.emitted('close')).toBeTruthy()
    first.unmount()

    const store = useReaperStore()
    expect(store.progress.length).toBeGreaterThan(0) // stale run survives the dialog

    const second = mountDialog()
    expect(sweepButton(second)).toBeDefined()
    expect(second.text()).toContain('Cancel')
    second.unmount()
  })

  it('still reports a failed run as done so the dialog stays open on Close', async () => {
    reaperSweep.mockImplementationOnce(async ({ itemIds }: { itemIds: string[] }) => {
      const results = itemIds.map((id, i) =>
        i === 0 ? okResult(id) : ({ itemId: id, ok: false, steps: [] } as unknown as CleanResult)
      )
      results.forEach((r) => onProgress?.(r))
      return results
    })
    const w = mountDialog()
    await sweepButton(w)!.trigger('click')
    await flushPromises()
    expect(w.emitted('close')).toBeFalsy()
    expect(sweepButton(w)).toBeUndefined()
    expect(w.text()).toContain('Close')
    w.unmount()
  })
})
