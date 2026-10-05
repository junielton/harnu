// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, defineComponent } from 'vue'
import { mount, flushPromises, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import ContainersSweepDialog from '../src/renderer/src/components/ContainersSweepDialog.vue'
import { useContainersStore } from '../src/renderer/src/stores/containers'
import { i18n } from '@renderer/i18n'
import { NOW, snapshotOf, specStacks, stack, ctr } from './helpers/containers-fixtures'
import { cloneGuardedApi, sentThroughIpc } from './helpers/containers-api'
import type { ContainersActResult, ContainersSnapshot, StackRow } from '../src/preload'

/**
 * T341 — the clean-up dialog: the one door to a sweep. What it discloses
 * before the operator confirms, and what it sends when they do.
 */

let containersAct: ReturnType<typeof vi.fn>

function stubApi(snap: ContainersSnapshot, result?: ContainersActResult): void {
  containersAct = vi.fn(async (): Promise<ContainersActResult> => {
    return result ?? { ok: true, verb: 'sweep', results: [], tombstone: null }
  })
  const api = {
    containersSnapshot: vi.fn(async () => snap),
    containersScan: vi.fn(async () => snap),
    containersAct,
    onContainersUpdate: () => () => {}
  }
  ;(window as unknown as { api: unknown }).api = cloneGuardedApi(api)
}

type StackResult = ContainersActResult['results'][number]

/** A per-stack result with every field main sends: the store reads them all. */
function res(over: Partial<StackResult> & { stack: string; ok: boolean }): StackResult {
  return {
    containerIds: [],
    freedRamBytes: 0,
    freedVolumeBytes: 0,
    portsReleased: [],
    removedContainers: [],
    removedVolumes: [],
    keptVolumes: [],
    ...over
  }
}

/** What `specStacks()`'s dialog lists: its three swept stacks, and the volumes it offers. */
const SPEC_DISCLOSURE = {
  stacks: ['proj-82', 'proj-11', 'proj-27'],
  volumes: ['proj-82_mysql', 'proj-11_mysql', 'proj-27_mysql']
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flushPromises()
}

async function openDialog(
  stacks: StackRow[],
  result?: ContainersActResult
): Promise<{ wrapper: VueWrapper; dom: DOMWrapper<Element>; closed: () => unknown[][] }> {
  const snap = snapshotOf(stacks)
  stubApi(snap, result)
  const store = useContainersStore()
  await store.init()
  await store.ensureScanned()
  const wrapper = mount(ContainersSweepDialog, {
    props: { stacks },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  await settle()
  // The dialog teleports to <body>, so it is queried there, not on the wrapper.
  return {
    wrapper,
    dom: new DOMWrapper(document.body),
    closed: () => wrapper.emitted('close') ?? []
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  // Each dialog teleports into <body>; clear it so one test never reads another's.
  document.body.innerHTML = ''
})

describe('T341 AC-2: what the dialog discloses', () => {
  it('states the stack count and the total container count', async () => {
    const { wrapper, dom } = await openDialog(specStacks())
    expect(dom.get('#containers-sweep-dialog-title').text()).toBe('Clean up 3 stacks?')
    // proj-82 has two containers; proj-11 and proj-27 one each.
    expect(dom.text()).toContain('4 containers will be removed.')
    expect(dom.get('[data-testid="containers-sweep-confirm"]').text()).toBe('Remove 4 containers')
    wrapper.unmount()
  })

  it('lists every swept stack with its container count, and nothing else', async () => {
    const { wrapper, dom } = await openDialog(specStacks())
    const rows = dom.findAll('[data-sweep-stack]').map((r) => ({
      id: r.attributes('data-sweep-stack'),
      text: r.text()
    }))
    expect(rows.map((r) => r.id)).toEqual(['proj-82', 'proj-11', 'proj-27'])
    expect(rows[0].text).toContain('2 containers')
    expect(rows[1].text).toContain('1 container')
    // active, protected, pending and unknown are never sweep targets.
    for (const id of ['proj-71', 'proj-20', 'proj-44', 'postgres-scratch']) {
      expect(dom.find(`[data-sweep-stack="${id}"]`).exists(), id).toBe(false)
    }
    wrapper.unmount()
  })
})

describe('T341 AC-3: the volume opt-in', () => {
  it('opens unchecked, aggregates one total, and sends removeVolumes: false when left alone', async () => {
    const { wrapper, dom } = await openDialog(specStacks())
    const box = dom.get('[data-testid="containers-sweep-volumes"]')
    expect((box.element as HTMLInputElement).checked).toBe(false)
    // 249.2 + 212.1 + 657.9 MB, one line for all three.
    expect(dom.text()).toContain('Also remove 3 volumes · 1.1 GB')

    await dom.get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()
    expect(containersAct.mock.calls).toEqual([
      [{ verb: 'sweep', removeVolumes: false, disclosed: SPEC_DISCLOSURE }]
    ])
    wrapper.unmount()
  })

  it('sends removeVolumes: true once ticked', async () => {
    const { wrapper, dom } = await openDialog(specStacks())
    await dom.get('[data-testid="containers-sweep-volumes"]').setValue(true)
    await dom.get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()
    expect(containersAct.mock.calls).toEqual([
      [{ verb: 'sweep', removeVolumes: true, disclosed: SPEC_DISCLOSURE }]
    ])
    wrapper.unmount()
  })

  it('names a shared volume a survivor still mounts, and offers one every owner is swept', async () => {
    const shared = { name: 'shared_cache', sizeBytes: 100_000_000, shared: true }
    const both = { name: 'both_zombies', sizeBytes: 50_000_000, shared: true }
    const stacks = [
      stack({ id: 'z-1', verdict: 'zombie', volumes: [shared, both], volumeBytes: 150_000_000 }),
      stack({ id: 'z-2', verdict: 'zombie', volumes: [both], volumeBytes: 50_000_000 }),
      stack({ id: 'a-1', verdict: 'active', volumes: [shared], volumeBytes: 100_000_000 })
    ]
    const { wrapper, dom } = await openDialog(stacks)
    // `both_zombies` has no survivor, so the sweep can take it; `shared_cache`
    // is still mounted by an active stack, so it is named as kept.
    expect(dom.text()).toContain('Also remove 1 volume · 50.0 MB')
    expect(dom.text()).toContain('shared_cache is shared with another stack, so it is kept.')
    expect(dom.text()).not.toContain('both_zombies is shared')
    wrapper.unmount()
  })
})

describe('T341: a volume two swept stacks share with a survivor', () => {
  it('is kept and named, never offered or added to the total', async () => {
    const vol = { name: 'shared_mid', sizeBytes: 80_000_000, shared: true }
    const own = { name: 'z1_data', sizeBytes: 20_000_000, shared: false }
    const { wrapper, dom } = await openDialog([
      stack({ id: 'z-1', verdict: 'zombie', volumes: [vol, own] }),
      stack({ id: 'z-2', verdict: 'zombie', volumes: [vol] }),
      stack({ id: 'a-1', verdict: 'active', volumes: [vol] })
    ])
    // Only the volume nothing outside the sweep mounts is counted: 1 volume, 20 MB.
    expect(dom.text()).toContain('Also remove 1 volume')
    expect(dom.text()).not.toContain('Also remove 2 volumes')
    expect(dom.text()).toContain('shared_mid is shared with another stack, so it is kept.')
    expect(dom.findAll('[data-sweep-stack]').map((r) => r.attributes('data-sweep-stack'))).toEqual([
      'z-1',
      'z-2'
    ])
    wrapper.unmount()
  })
})

describe('T341: while the sweep runs', () => {
  it('the confirm button carries the N of M count the dialog is covering', async () => {
    const { wrapper, dom } = await openDialog(specStacks())
    containersAct.mockImplementation(() => new Promise(() => {}))
    await dom.get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()
    const confirm = dom.get('[data-testid="containers-sweep-confirm"]')
    expect(confirm.text()).toBe('Cleaning… 0 of 3')
    expect((confirm.element as HTMLButtonElement).disabled).toBe(true)
    wrapper.unmount()
  })
})

describe('T341 AC-6: a partial sweep', () => {
  it('names which stacks failed and why, and says how many were cleaned', async () => {
    const result: ContainersActResult = {
      ok: false,
      verb: 'sweep',
      results: [
        res({ stack: 'proj-82', ok: true }),
        res({ stack: 'proj-11', ok: true }),
        res({
          stack: 'proj-27',
          ok: false,
          error: 'DOCKER_FAILED',
          message: 'Error response from daemon: device or resource busy'
        })
      ],
      tombstone: null
    }
    const { wrapper, dom, closed } = await openDialog(specStacks(), result)
    await dom.get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()

    const note = dom.get('[data-testid="containers-sweep-problem"]').text()
    expect(note).toContain('Cleaned 2 of 3 stacks. These were not:')
    expect(note).toContain('proj-27 — Error response from daemon: device or resource busy')
    // The ones that succeeded are not hidden: they are simply not listed as failed.
    expect(note).not.toContain('proj-82')
    expect(note).not.toContain('proj-11')
    // The dialog stays open so the operator reads what happened.
    expect(closed()).toHaveLength(0)
    wrapper.unmount()
  })

  it('a one-stack sweep that failed reads in the singular', async () => {
    const result: ContainersActResult = {
      ok: false,
      verb: 'sweep',
      results: [res({ stack: 'proj-82', ok: false, error: 'STACK_NOT_FOUND' })],
      tombstone: null
    }
    const { wrapper, dom } = await openDialog([stack({ id: 'proj-82', verdict: 'zombie' })], result)
    await dom.get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()
    const note = dom.get('[data-testid="containers-sweep-problem"]').text()
    expect(note).toContain('Cleaned 0 of 1 stack. This one was not:')
    expect(note).not.toContain('1 stacks')
    wrapper.unmount()
  })

  it('a refused stack reads with the shared refusal wording', async () => {
    const result: ContainersActResult = {
      ok: false,
      verb: 'sweep',
      results: [res({ stack: 'proj-82', ok: false, error: 'STACK_NOT_FOUND' })],
      tombstone: null
    }
    const { wrapper, dom } = await openDialog(specStacks(), result)
    await dom.get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()
    expect(dom.get('[data-testid="containers-sweep-problem"]').text()).toContain(
      'proj-82 — the stack is gone from the latest scan'
    )
    wrapper.unmount()
  })

  it('a request that never ran says so and keeps the dialog open', async () => {
    const result: ContainersActResult = {
      ok: false,
      verb: 'sweep',
      error: 'DOCKER_UNAVAILABLE',
      results: [],
      tombstone: null
    }
    const { wrapper, dom, closed } = await openDialog(specStacks(), result)
    await dom.get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()
    expect(dom.get('[data-testid="containers-sweep-problem"]').text()).toBe(
      "The action didn't run — docker isn't reachable."
    )
    expect(closed()).toHaveLength(0)
    wrapper.unmount()
  })
})

describe('T341 AC-4: one sweep at a time', () => {
  it('a second confirm while the first is in flight sends nothing more', async () => {
    const { wrapper, dom } = await openDialog(specStacks())
    containersAct.mockImplementation(() => new Promise(() => {}))
    const confirm = dom.get('[data-testid="containers-sweep-confirm"]')
    await confirm.trigger('click')
    await settle()
    expect((confirm.element as HTMLButtonElement).disabled).toBe(true)
    await confirm.trigger('click')
    await settle()
    expect(containersAct).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('Esc closes it without acting', async () => {
    const { wrapper, closed } = await openDialog(specStacks())
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await settle()
    expect(closed()).toEqual([[null]])
    expect(containersAct).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('Cancel closes it without acting', async () => {
    const { wrapper, dom, closed } = await openDialog(specStacks())
    const cancel = dom.findAll('button').find((b) => b.text() === 'Cancel')
    await cancel!.trigger('click')
    await settle()
    expect(closed()).toEqual([[null]])
    expect(containersAct).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('a stack with no containers still counts as a stack, never as zero work', async () => {
    const stacks = [
      stack({ id: 'z-9', verdict: 'zombie', containers: [ctr({ id: 'k1', name: 'z-9-app-1' })] })
    ]
    const { wrapper, dom } = await openDialog(stacks)
    expect(dom.get('#containers-sweep-dialog-title').text()).toBe('Clean up 1 stack?')
    expect(dom.text()).toContain('1 container will be removed.')
    wrapper.unmount()
  })
})

/**
 * BUG-141 — the confirm has to SURVIVE the crossing, not merely be the right
 * shape. The two sibling guards below assert what the dialog sends; neither
 * could ever have caught the first real sweep failing with "An object could
 * not be cloned", because a mock takes a Vue Proxy happily and Electron does
 * not. These assert sendability, against the payload as the dialog built it.
 */
describe('BUG-141: the confirmed payload crosses the real IPC', () => {
  it('hands the IPC plain data, not a reactive Proxy', async () => {
    const { wrapper, dom } = await openDialog(specStacks())
    await dom.get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()

    const calls = sentThroughIpc().filter((c) => c.channel === 'containersAct')
    expect(calls, 'the confirm sent nothing').toHaveLength(1)
    // Exactly what Electron's structured clone does with it. A `ref`'s deep
    // reactive Proxy throws DataCloneError here; plain data does not.
    expect(() => structuredClone(calls[0].args[0])).not.toThrow()
    wrapper.unmount()
  })

  it('sends a volume list that is a plain array, not the reactive one it renders', async () => {
    const { wrapper, dom } = await openDialog(specStacks())
    await dom.get('[data-testid="containers-sweep-volumes"]').setValue(true)
    await dom.get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()

    const [sweep] = sentThroughIpc().filter((c) => c.channel === 'containersAct')
    const req = sweep.args[0] as { disclosed: { stacks: string[]; volumes: string[] } }
    // The one field BUG-139 turned reactive: read straight off the sent payload.
    expect(() => structuredClone(req.disclosed.volumes)).not.toThrow()
    expect(req.disclosed.volumes).toEqual(SPEC_DISCLOSURE.volumes)
    wrapper.unmount()
  })
})

/**
 * BUG-137 — the dialog is binding. It sends what it rendered; main compares
 * that against its own fresh scan and refuses the sweep whole when the two
 * disagree. Here: what the dialog does with that refusal.
 */
describe('BUG-137: a set that moved under the operator', () => {
  const CHANGED: ContainersActResult = {
    ok: false,
    verb: 'sweep',
    error: 'SWEEP_SET_CHANGED',
    message: 'the list moved after the dialog showed it; nothing was removed',
    results: [],
    tombstone: null
  }

  /**
   * The dialog as the view mounts it: its `stacks` prop is a computed over the
   * store, so a rescan the dialog triggers is what refreshes its own list.
   */
  async function openBoundDialog(
    first: StackRow[],
    next: StackRow[]
  ): Promise<{ wrapper: VueWrapper; dom: DOMWrapper<Element>; scans: () => number }> {
    let scans = 0
    containersAct = vi.fn(async (): Promise<ContainersActResult> => CHANGED)
    const api = {
      containersSnapshot: vi.fn(async () => snapshotOf(first)),
      containersScan: vi.fn(async () => {
        scans += 1
        return snapshotOf(next)
      }),
      containersAct,
      onContainersUpdate: () => () => {}
    }
    ;(window as unknown as { api: unknown }).api = cloneGuardedApi(api)
    const store = useContainersStore()
    await store.init()
    const host = defineComponent({
      components: { ContainersSweepDialog },
      setup() {
        const s = useContainersStore()
        // The view's own binding: the WHOLE snapshot, never a pre-filtered set
        // — `sweepPlan` needs the survivors to judge a shared volume (T341).
        return { all: computed(() => s.stacks) }
      },
      template: '<ContainersSweepDialog :stacks="all" />'
    })
    const wrapper = mount(host, { global: { plugins: [i18n] }, attachTo: document.body })
    await settle()
    return { wrapper, dom: new DOMWrapper(document.body), scans: () => scans }
  }

  it('stays open, says nothing was deleted, shows the new set, and never retries', async () => {
    const shown = [stack({ id: 'z-1', verdict: 'zombie' })]
    // The scan main refused against: a second stack crossed its threshold.
    const moved = [...shown, stack({ id: 'z-2', verdict: 'zombie' })]
    const { wrapper, dom, scans } = await openBoundDialog(shown, moved)

    expect(dom.get('#containers-sweep-dialog-title').text()).toBe('Clean up 1 stack?')
    await dom.get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()

    // It never fires a second time on its own.
    expect(containersAct).toHaveBeenCalledTimes(1)
    expect(containersAct.mock.calls[0][0]).toEqual({
      verb: 'sweep',
      removeVolumes: false,
      disclosed: { stacks: ['z-1'], volumes: [] }
    })
    // The refusal is stated plainly, and says nothing was deleted.
    expect(dom.get('[data-testid="containers-sweep-problem"]').text()).toBe(
      'The list changed while this dialog was open, so nothing was deleted. Check what the clean-up would take now and confirm again.'
    )
    // It rescanned, and the list it now shows is the one main would act on.
    expect(scans()).toBeGreaterThan(0)
    expect(dom.get('#containers-sweep-dialog-title').text()).toBe('Clean up 2 stacks?')
    expect(dom.find('[data-sweep-stack="z-2"]').exists()).toBe(true)
    // Still open, and ready for a fresh confirm.
    expect(dom.find('[data-dsqa="containers-sweep-dialog"]').exists()).toBe(true)
    const confirm = dom.get('[data-testid="containers-sweep-confirm"]')
    expect((confirm.element as HTMLButtonElement).disabled).toBe(false)
    wrapper.unmount()
  })

  it('AC-5: the copy is a key in both locales, and each says nothing was deleted', () => {
    const keys = ['containers.sweepDialog.changed', 'containers.refusal.SWEEP_SET_CHANGED']
    for (const locale of ['en', 'pt-BR'] as const) {
      for (const key of keys) {
        expect(i18n.global.te(key, locale), `${key} @ ${locale}`).toBe(true)
      }
    }
    expect(i18n.global.t('containers.sweepDialog.changed', {}, { locale: 'en' })).toContain(
      'nothing was deleted'
    )
    expect(i18n.global.t('containers.sweepDialog.changed', {}, { locale: 'pt-BR' })).toContain(
      'nada foi apagado'
    )
  })

  it('the fresh confirm asserts the NEW set, so a second sweep is not the stale one', async () => {
    const shown = [stack({ id: 'z-1', verdict: 'zombie' })]
    const moved = [...shown, stack({ id: 'z-2', verdict: 'zombie' })]
    const { wrapper, dom } = await openBoundDialog(shown, moved)
    await dom.get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()
    await dom.get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()
    expect(containersAct).toHaveBeenCalledTimes(2)
    expect(containersAct.mock.calls[1][0]).toEqual({
      verb: 'sweep',
      removeVolumes: false,
      disclosed: { stacks: ['z-1', 'z-2'], volumes: [] }
    })
    wrapper.unmount()
  })
})

/**
 * BUG-139 — the disclosure is frozen at open. BUG-137 closed "main's set moved
 * after the dialog rendered"; this is the other half: "the dialog's own set
 * moved while the operator was reading it". The plan is read once, and a
 * snapshot that moves it is never swapped in silently — the operator is told
 * and confirms again, which is the SWEEP_SET_CHANGED beat without the round
 * trip to main.
 */
describe('BUG-139: a snapshot landing while the dialog is open', () => {
  /**
   * The dialog as the view mounts it — `:stacks` bound to the live store — plus
   * the push channel a background scan lands on (`containers:update`).
   */
  async function openLiveDialog(
    first: StackRow[],
    result?: ContainersActResult
  ): Promise<{
    wrapper: VueWrapper
    dom: DOMWrapper<Element>
    push: (stacks: StackRow[]) => Promise<void>
  }> {
    let onUpdate: ((snap: ContainersSnapshot) => void) | null = null
    containersAct = vi.fn(async (): Promise<ContainersActResult> => {
      return result ?? { ok: true, verb: 'sweep', results: [], tombstone: null }
    })
    const api = {
      containersSnapshot: vi.fn(async () => snapshotOf(first)),
      containersScan: vi.fn(async () => snapshotOf(first)),
      containersAct,
      onContainersUpdate: (cb: (snap: ContainersSnapshot) => void) => {
        onUpdate = cb
        return () => {}
      }
    }
    ;(window as unknown as { api: unknown }).api = cloneGuardedApi(api)
    const store = useContainersStore()
    await store.init()
    const host = defineComponent({
      components: { ContainersSweepDialog },
      setup() {
        const s = useContainersStore()
        return { all: computed(() => s.stacks) }
      },
      template: '<ContainersSweepDialog :stacks="all" />'
    })
    const wrapper = mount(host, { global: { plugins: [i18n] }, attachTo: document.body })
    await settle()
    return {
      wrapper,
      dom: new DOMWrapper(document.body),
      push: async (stacks: StackRow[]) => {
        onUpdate?.(snapshotOf(stacks))
        await settle()
      }
    }
  }

  const zombie = (id: string): StackRow => stack({ id, verdict: 'zombie' })

  it('AC-2: says the list moved instead of swapping it in silently, and never retries', async () => {
    const { wrapper, dom, push } = await openLiveDialog([zombie('z-1')])
    expect(dom.get('#containers-sweep-dialog-title').text()).toBe('Clean up 1 stack?')
    expect(dom.find('[data-testid="containers-sweep-problem"]').exists()).toBe(false)

    await push([zombie('z-1'), zombie('z-2')])

    // The operator is told — the same beat as a refusal, without asking main.
    expect(dom.get('[data-testid="containers-sweep-problem"]').text()).toContain(
      'The list changed while this dialog was open'
    )
    // It waits for a new confirm: nothing was sent on its own.
    expect(containersAct).not.toHaveBeenCalled()
    // And what it now shows is what a confirm would assert.
    expect(dom.get('#containers-sweep-dialog-title').text()).toBe('Clean up 2 stacks?')
    await dom.get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()
    expect(containersAct.mock.calls[0][0]).toEqual({
      verb: 'sweep',
      removeVolumes: false,
      disclosed: { stacks: ['z-1', 'z-2'], volumes: [] }
    })
    wrapper.unmount()
  })

  it('AC-2: a snapshot that leaves the set where it was raises nothing', async () => {
    const { wrapper, dom, push } = await openLiveDialog([zombie('z-1')])
    // A fresh scan of the same machine: new objects, same sweep.
    await push([zombie('z-1')])
    expect(dom.find('[data-testid="containers-sweep-problem"]').exists()).toBe(false)
    expect(dom.get('#containers-sweep-dialog-title').text()).toBe('Clean up 1 stack?')
    wrapper.unmount()
  })

  it('AC-1: a snapshot landing mid-sweep never moves the list the operator confirmed', async () => {
    const all = [zombie('z-1'), zombie('z-2'), zombie('z-3')]
    const { wrapper, dom, push } = await openLiveDialog(all)
    containersAct.mockImplementation(() => new Promise(() => {}))
    await dom.get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()

    // The sweep is working: two stacks are already gone from the machine.
    await push([zombie('z-3')])

    expect(dom.findAll('[data-sweep-stack]').map((r) => r.attributes('data-sweep-stack'))).toEqual([
      'z-1',
      'z-2',
      'z-3'
    ])
    expect(dom.get('#containers-sweep-dialog-title').text()).toBe('Clean up 3 stacks?')
    // A sweep eating its own list is not "the list changed under you".
    expect(dom.find('[data-testid="containers-sweep-problem"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('AC-1: the confirmed payload is the list that was on screen, not a later one', async () => {
    const { wrapper, dom, push } = await openLiveDialog([zombie('z-1')])
    let landed: (() => void) | null = null
    containersAct.mockImplementation(
      () =>
        new Promise((resolve) => {
          landed = () => resolve({ ok: true, verb: 'sweep', results: [], tombstone: null })
        })
    )
    await dom.get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()
    // A scan lands between the click and main's answer.
    await push([zombie('z-1'), zombie('z-2')])
    landed?.()
    await settle()
    expect(containersAct.mock.calls).toEqual([
      [{ verb: 'sweep', removeVolumes: false, disclosed: { stacks: ['z-1'], volumes: [] } }]
    ])
    wrapper.unmount()
  })

  it('AC-3: a refusal says nothing was deleted, not merely that the list moved', async () => {
    const refusal: ContainersActResult = {
      ok: false,
      verb: 'sweep',
      error: 'SWEEP_SET_CHANGED',
      message: 'the list moved after the dialog showed it; nothing was removed',
      results: [],
      tombstone: null
    }
    const { wrapper, dom } = await openLiveDialog([zombie('z-1')], refusal)
    await dom.get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()
    // The refusal's own copy wins over the in-dialog one the rescan would raise.
    expect(dom.get('[data-testid="containers-sweep-problem"]').text()).toBe(
      'The list changed while this dialog was open, so nothing was deleted. Check what the clean-up would take now and confirm again.'
    )
    wrapper.unmount()
  })
})
