import { describe, it, expect, beforeEach, vi } from 'vitest'
import { isReactive, ref } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useContainersStore } from '../src/renderer/src/stores/containers'
import { useNotificationsStore } from '../src/renderer/src/stores/notifications'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { snapshotOf, specStacks } from './helpers/containers-fixtures'
import { cloneGuardedApi, sentThroughIpc } from './helpers/containers-api'
import type {
  ContainersActResult,
  ContainersNewZombiesAlert,
  ContainersSnapshot
} from '../src/preload'

/**
 * T331 — the Containers renderer store over U1's IPC (T330). Stubs
 * `window.api` the way `tests/reaper-store.test.ts` does, with the push
 * subscription captured so a test can fire it.
 */

function okResult(verb: NonNullable<ContainersActResult['verb']>): ContainersActResult {
  return { ok: true, verb, results: [], tombstone: null }
}

function installApi(initial: ContainersSnapshot | null): {
  push: (snap: ContainersSnapshot) => void
  alert: (alert: ContainersNewZombiesAlert) => void
  containersAct: ReturnType<typeof vi.fn>
  containersScan: ReturnType<typeof vi.fn>
} {
  let handler: ((snap: ContainersSnapshot) => void) | null = null
  let alertHandler: ((alert: ContainersNewZombiesAlert) => void) | null = null
  const containersAct = vi.fn(async (): Promise<ContainersActResult> => okResult('stop'))
  const containersScan = vi.fn(async () => initial ?? snapshotOf([]))
  ;(globalThis as unknown as { window: unknown }).window = {
    api: cloneGuardedApi({
      containersSnapshot: vi.fn(async () => initial),
      containersScan,
      containersAct,
      onContainersUpdate: (cb: (snap: ContainersSnapshot) => void) => {
        handler = cb
        return () => (handler = null)
      },
      onContainersNewZombies: (cb: (alert: ContainersNewZombiesAlert) => void) => {
        alertHandler = cb
        return () => (alertHandler = null)
      }
    })
  }
  // The containers store keeps nothing in localStorage; the notifications store
  // (the new-zombie bell entry, T332) persists its history there.
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0
  }
  return {
    push: (snap) => handler?.(snap),
    alert: (a) => alertHandler?.(a),
    containersAct,
    containersScan
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('containers store', () => {
  it('records a new-zombie alert in the notification center; a click opens the takeover', async () => {
    const api = installApi(null)
    const store = useContainersStore()
    await store.init()

    api.alert({ count: 4, names: ['a', 'b', 'c', 'd'] })
    api.alert({ count: 1, names: ['e'] })
    const [latest, first] = useNotificationsStore().list
    expect(first).toMatchObject({
      source: 'app',
      kind: 'info',
      title: '4 stacks just became zombies',
      description: 'a, b, c +1 more — open Containers to review',
      target: { view: 'containers' }
    })
    expect(latest).toMatchObject({
      title: '1 stack just became a zombie',
      description: 'e — open Containers to review'
    })

    // What the Activity bell does with a view-targeted row.
    const ui = useUiStore()
    ui.openNavigableView(first!.target!.view, first!.target)
    expect(ui.activeView?.id).toBe('containers')
  })

  it('reads the last snapshot on init and follows pushes', async () => {
    const first = snapshotOf(specStacks())
    const api = installApi(first)
    const store = useContainersStore()
    await store.init()
    expect(store.snapshot).toEqual(first)

    const next = snapshotOf(specStacks().slice(0, 1))
    api.push(next)
    expect(store.stacks.map((s) => s.id)).toEqual(['proj-82'])
  })

  it('AC-9: the footer count is zombie + orphan stacks, and 0 before the first scan', async () => {
    installApi(null)
    const store = useContainersStore()
    await store.init()
    expect(store.needsYouCount).toBe(0)
    store.snapshot = snapshotOf(specStacks())
    // proj-82 + proj-11 (zombies) + proj-27 (orphan)
    expect(store.needsYouCount).toBe(3)
    expect(store.needsYou.map((s) => s.id)).toEqual(['proj-82', 'proj-11', 'proj-27'])
    expect(store.leaveAlone.map((s) => s.verdict)).toEqual([
      'active',
      'protected',
      'pending',
      'unknown'
    ])
  })

  it('never scans on init — only the view asks for a first scan', async () => {
    const api = installApi(null)
    const store = useContainersStore()
    await store.init()
    expect(api.containersScan).not.toHaveBeenCalled()
    await store.ensureScanned()
    expect(api.containersScan).toHaveBeenCalledTimes(1)
  })

  it('AC-4: a bulk stop is sent as { verb: stop, bulk: true } and only targets running Needs-you stacks for display', async () => {
    const api = installApi(snapshotOf(specStacks()))
    const store = useContainersStore()
    await store.init()

    let seenPending: string[] = []
    api.containersAct.mockImplementationOnce(async () => {
      seenPending = [...(store.pending?.stacks ?? [])]
      return okResult('stop')
    })
    await store.act({ verb: 'stop', bulk: true })

    expect(api.containersAct).toHaveBeenCalledWith({ verb: 'stop', bulk: true })
    // Only the running zombie — never active, protected, pending or unknown.
    expect(seenPending).toEqual(['proj-82'])
    expect(store.pending).toBeNull()
  })

  it('refuses to start a second action while one is in flight', async () => {
    const api = installApi(snapshotOf(specStacks()))
    const store = useContainersStore()
    await store.init()
    let release!: () => void
    api.containersAct.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(okResult('stop'))))
    )
    const first = store.act({ verb: 'stop', stacks: ['proj-82'] })
    expect(await store.act({ verb: 'start', stacks: ['proj-11'] })).toBeNull()
    release()
    await first
    expect(api.containersAct).toHaveBeenCalledTimes(1)
  })

  it("AC-5: records docker's own error per stack, with how far the action got", async () => {
    const api = installApi(snapshotOf(specStacks()))
    const store = useContainersStore()
    await store.init()
    api.containersAct.mockResolvedValueOnce({
      ok: false,
      verb: 'stop',
      results: [
        {
          stack: 'proj-82',
          ok: false,
          error: 'DOCKER_FAILED',
          message: 'Error response from daemon: permission denied',
          containerIds: ['a1'],
          freedBytes: 0,
          portsReleased: [],
          removedContainers: [],
          removedVolumes: [],
          keptVolumes: []
        }
      ],
      tombstone: null
    })
    await store.act({ verb: 'stop', stacks: ['proj-82'] })
    expect(store.failures['proj-82']).toEqual({
      verb: 'stop',
      kind: 'failed',
      code: 'DOCKER_FAILED',
      message: 'Error response from daemon: permission denied',
      done: 1,
      total: 2
    })

    // A new action on the stack clears the old failure.
    await store.act({ verb: 'stop', stacks: ['proj-82'] })
    expect(store.failures['proj-82']).toBeUndefined()
  })

  it('a failure survives a scan that leaves its stack alone, and goes once the stack moves', async () => {
    const api = installApi(snapshotOf(specStacks()))
    const store = useContainersStore()
    await store.init()
    api.containersAct.mockResolvedValueOnce({
      ok: false,
      verb: 'stop',
      results: [
        {
          stack: 'proj-82',
          ok: false,
          error: 'DOCKER_FAILED',
          message: 'Error response from daemon: permission denied',
          containerIds: [],
          freedBytes: 0,
          portsReleased: [],
          removedContainers: [],
          removedVolumes: [],
          keptVolumes: []
        }
      ],
      tombstone: null
    })
    await store.act({ verb: 'stop', stacks: ['proj-82'] })
    expect(store.failures['proj-82']?.kind).toBe('failed')

    api.push(snapshotOf(specStacks()))
    expect(store.failures['proj-82']?.kind).toBe('failed')

    // Stopped outside Harnu: the note and its "Try again" no longer describe it.
    api.push(
      snapshotOf(
        specStacks().map((s) =>
          s.id === 'proj-82'
            ? {
                ...s,
                running: false,
                containers: s.containers.map((c) => ({ ...c, running: false }))
              }
            : s
        )
      )
    )
    expect(store.failures['proj-82']).toBeUndefined()
  })

  it('a request-level refusal marks every target', async () => {
    const api = installApi(snapshotOf(specStacks()))
    const store = useContainersStore()
    await store.init()
    api.containersAct.mockResolvedValueOnce({
      ok: false,
      verb: 'start',
      error: 'DOCKER_UNAVAILABLE',
      message: 'docker CLI not found on PATH',
      results: [],
      tombstone: null
    })
    await store.act({ verb: 'start', stacks: ['proj-11'] })
    expect(store.failures['proj-11']?.kind).toBe('request')
    expect(store.failures['proj-11']?.code).toBe('DOCKER_UNAVAILABLE')
  })
})

describe('T341: the sweep, in the store', () => {
  it("mirrors main's target set and baselines every container of each one", async () => {
    const api = installApi(snapshotOf(specStacks()))
    const store = useContainersStore()
    await store.init()
    let seen: { stacks: string[]; baseline: Record<string, string[]> } | null = null
    api.containersAct.mockImplementation(async () => {
      seen = {
        stacks: [...(store.pending?.stacks ?? [])],
        baseline: { ...(store.pending?.baseline ?? {}) }
      }
      return okResult('sweep')
    })

    await store.act({ verb: 'sweep', removeVolumes: false })
    expect(seen!.stacks).toEqual(['proj-82', 'proj-11', 'proj-27'])
    // A sweep stops the running containers first, so none of them survives it.
    expect(seen!.baseline['proj-82']).toEqual(['a1', 'a2'])
    expect(seen!.baseline['proj-27']).toEqual(['c1'])
    // It is not a bulk stop: that flag stays the stop button's.
    expect(store.pending).toBeNull()
  })

  it('refuses a second sweep while one is in flight', async () => {
    const api = installApi(snapshotOf(specStacks()))
    const store = useContainersStore()
    await store.init()
    let release: (r: ContainersActResult) => void = () => {}
    api.containersAct.mockImplementationOnce(
      () => new Promise<ContainersActResult>((resolve) => (release = resolve))
    )

    const first = store.act({ verb: 'sweep', removeVolumes: true })
    expect(store.pending?.verb).toBe('sweep')
    expect(await store.act({ verb: 'sweep', removeVolumes: true })).toBeNull()
    expect(api.containersAct).toHaveBeenCalledTimes(1)

    release(okResult('sweep'))
    await first
    expect(store.pending).toBeNull()
  })

  it('records a per-stack sweep failure the detail pane can word', async () => {
    const api = installApi(snapshotOf(specStacks()))
    const store = useContainersStore()
    await store.init()
    api.containersAct.mockResolvedValueOnce({
      ok: false,
      verb: 'sweep',
      results: [
        {
          stack: 'proj-27',
          ok: false,
          error: 'DOCKER_FAILED',
          message: 'Error response from daemon: device or resource busy',
          containerIds: [],
          freedRamBytes: 0,
          freedVolumeBytes: 0,
          portsReleased: [],
          removedContainers: [],
          removedVolumes: [],
          keptVolumes: []
        }
      ],
      tombstone: null
    })
    await store.act({ verb: 'sweep', removeVolumes: false })
    expect(store.failures['proj-27']).toMatchObject({
      verb: 'sweep',
      kind: 'failed',
      code: 'DOCKER_FAILED',
      total: 1
    })
  })

  it('sends no target list: main picks the set itself', async () => {
    const api = installApi(snapshotOf(specStacks()))
    const store = useContainersStore()
    await store.init()
    await store.act({ verb: 'sweep', removeVolumes: false })
    expect(api.containersAct).toHaveBeenCalledWith({ verb: 'sweep', removeVolumes: false })
  })
})

/**
 * BUG-141 — `act` is the renderer's only door to `containersAct`, so it is
 * where a request stops being reactive. Every caller builds its payload from
 * store state, and a `ref` holding an object hands out deep reactive Proxies;
 * Electron's structured clone rejects those ("An object could not be cloned"),
 * which is how the first real sweep died. The door owns the crossing, so no
 * call site has to remember.
 */
describe('containers store: what crosses the IPC', () => {
  it('unwraps a reactive payload into plain data', async () => {
    installApi(snapshotOf(specStacks()))
    const store = useContainersStore()
    await store.init()

    // Exactly the dialog's shape: a `ref` over the plan, its `volumes` read
    // straight off `.value` — the reactive array BUG-139 introduced.
    const plan = ref({
      stacks: [{ id: 'proj-82' }, { id: 'proj-11' }],
      volumes: ['proj-82_mysql', 'proj-11_mysql']
    })
    expect(isReactive(plan.value.volumes), 'the fixture must be reactive').toBe(true)

    await store.act({
      verb: 'sweep',
      removeVolumes: true,
      disclosed: {
        stacks: plan.value.stacks.map((s) => s.id),
        volumes: plan.value.volumes
      }
    })

    const [sweep] = sentThroughIpc().filter((c) => c.channel === 'containersAct')
    expect(sweep, 'the store sent nothing').toBeTruthy()
    const req = sweep.args[0] as { disclosed: { volumes: string[] } }
    expect(isReactive(req.disclosed.volumes)).toBe(false)
    expect(() => structuredClone(sweep.args[0])).not.toThrow()
    expect(req.disclosed.volumes).toEqual(['proj-82_mysql', 'proj-11_mysql'])
  })

  it('leaves an already-plain request exactly as it was', async () => {
    installApi(snapshotOf(specStacks()))
    const store = useContainersStore()
    await store.init()
    await store.act({ verb: 'stop', stacks: ['proj-82'], force: true })
    const [stop] = sentThroughIpc().filter((c) => c.channel === 'containersAct')
    expect(stop.args[0]).toEqual({ verb: 'stop', stacks: ['proj-82'], force: true })
  })
})
