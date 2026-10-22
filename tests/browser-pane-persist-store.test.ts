// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reactive } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import {
  payloadPatchFromPersist,
  payloadPatchFromState
} from '../src/renderer/src/lib/browser-persist'
import { ipcFn } from './helpers/ipc-clone'

/**
 * T574 (U7, AC-6) — the helpers store keeps a browser pane's restorable state on the pane and writes it to
 * `helpers.json` through the same IPC boundary the app uses: a reactive proxy of the live store inside the payload
 * (the emulation record, the pins) made `helpers:set` throw "An object could not be cloned" in the live app and
 * the file silently stopped updating. `ipcFn` clones its arguments exactly as `ipcRenderer.invoke` does.
 */

const WT = '/repo/alpha'
const PANE = 'bp-aaaa1111'

let helpersSet: ReturnType<typeof ipcFn>

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  helpersSet = ipcFn(async () => undefined)
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {
      helpersGet: vi.fn(async () => ({ splitVisible: false, splitRatio: 0.65, panes: [] })),
      helpersSet,
      browserDestroy: vi.fn(async () => true)
    },
    { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => () => {}) }
  )
})
afterEach(() => vi.useRealTimers())

async function flushed(): Promise<void> {
  await vi.advanceTimersByTimeAsync(700)
}

function addPane(helpers: ReturnType<typeof useHelpersStore>): void {
  helpers.addBrowserHelper(WT, {
    paneId: PANE,
    name: 'cart',
    url: 'http://localhost:3000/cart',
    openedBy: 'agent',
    partition: 'agent',
    ownerSessionId: 'sess-1',
    pagePath: null
  })
}

describe('a browser pane in helpers.json', () => {
  it('is written (persistable) with its payload', async () => {
    const helpers = useHelpersStore()
    await helpers.ensureLoaded(WT)
    addPane(helpers)
    await flushed()
    expect(helpersSet).toHaveBeenCalled()
    const written = helpersSet.mock.calls.at(-1)![0] as {
      state: { panes: Array<Record<string, unknown>> }
    }
    expect(written.state.panes).toHaveLength(1)
    expect(written.state.panes[0]).toMatchObject({
      id: PANE,
      type: 'browser',
      payload: { url: 'http://localhost:3000/cart', openedBy: 'agent', ownerSessionId: 'sess-1' }
    })
  })

  it('keeps the pushed zoom, emulation and pins, and the write survives the IPC clone', async () => {
    const helpers = useHelpersStore()
    await helpers.ensureLoaded(WT)
    addPane(helpers)
    await flushed()
    const emulation = reactive({
      device: { preset: 'phone-m', width: 390, height: 844, dpr: 3, mobile: true, rotated: false },
      colorScheme: 'dark'
    })
    helpers.patchBrowserPayload(PANE, (saved) =>
      payloadPatchFromState(saved, {
        url: 'http://localhost:3000/pay',
        pagePath: null,
        zoom: 1.25,
        emulation: emulation as never,
        allowNetwork: false
      })
    )
    helpers.patchBrowserPayload(PANE, (saved) =>
      payloadPatchFromPersist(saved, {
        pins: [{ id: 'p1', n: 1, comment: 'x' }],
        scroll: { x: 0, y: 500 }
      })
    )
    // a second patch reads the payload back through the reactive state: its nested values must stay plain
    helpers.patchBrowserPayload(PANE, (saved) =>
      payloadPatchFromPersist(saved, { scroll: { x: 0, y: 600 } })
    )
    await flushed()
    const calls = helpersSet.mock.calls
    const written = calls.at(-1)![0] as {
      state: { panes: Array<{ payload: Record<string, unknown> }> }
    }
    expect(written.state.panes[0]!.payload).toMatchObject({
      url: 'http://localhost:3000/pay',
      zoom: 1.25,
      emulation: { device: { preset: 'phone-m' }, colorScheme: 'dark' },
      pins: [{ id: 'p1', n: 1, comment: 'x' }],
      scroll: { x: 0, y: 600 }
    })
  })

  it('survives a rebalance and a ratio drag: a pane spread through the reactive state holds a proxy of its payload', async () => {
    const helpers = useHelpersStore()
    await helpers.ensureLoaded(WT)
    addPane(helpers)
    helpers.patchBrowserPayload(PANE, () => ({ zoom: 1.5, pins: [{ id: 'p1' }] }))
    // a second pane rebalances every ratio by spreading the first, and a drag does the same
    helpers.addBrowserHelper(WT, {
      paneId: 'bp-bbbb2222',
      name: 'second',
      url: 'http://localhost:3000/second',
      openedBy: 'operator',
      partition: 'operator',
      ownerSessionId: null
    })
    helpers.setPaneRatios(WT, [0.3, 0.7])
    await flushed()
    const written = helpersSet.mock.calls.at(-1)![0] as {
      state: { panes: Array<{ id: string; payload: Record<string, unknown> }> }
    }
    expect(written.state.panes.map((p) => p.id)).toEqual([PANE, 'bp-bbbb2222'])
    expect(written.state.panes[0]!.payload).toMatchObject({ zoom: 1.5, pins: [{ id: 'p1' }] })
  })

  it('writes nothing for a patch that changes nothing', async () => {
    const helpers = useHelpersStore()
    await helpers.ensureLoaded(WT)
    addPane(helpers)
    await flushed()
    const before = helpersSet.mock.calls.length
    helpers.patchBrowserPayload(PANE, (saved) =>
      payloadPatchFromState(saved, {
        url: 'http://localhost:3000/cart',
        pagePath: null,
        zoom: 1,
        emulation: {},
        allowNetwork: false
      })
    )
    await flushed()
    expect(helpersSet.mock.calls.length).toBe(before)
  })

  it('ignores a pane the store does not hold', async () => {
    const helpers = useHelpersStore()
    await helpers.ensureLoaded(WT)
    helpers.patchBrowserPayload('bp-missing', () => ({ zoom: 2 }))
    await flushed()
    expect(helpersSet).not.toHaveBeenCalled()
  })
})
